import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_KEY,
  buildDiagnostics,
  dismissQuarantineRecords,
  getQuarantineRecords,
  loadStore,
  saveStore,
  tmpKeyOf,
  type StorageLike,
  type StoreSchema,
} from './persist';
import {
  REGRESSION_STORAGE_KEY,
  RULES_STORAGE_KEY,
  regressionStore,
  rulesStore,
} from './stores';
import { validateRules } from './validate';
import { SAMPLE_RULES } from './samples';

/** 内存存储：记录操作顺序，支持按键注入读写故障与读回篡改 */
class MockStorage implements StorageLike {
  readonly map = new Map<string, string>();
  readonly ops: string[] = [];
  /** setItem 时抛错的键（模拟配额超限等写入失败） */
  readonly failSet = new Set<string>();
  /** getItem 时抛错的键（模拟隐私模式） */
  readonly failGet = new Set<string>();
  /** getItem 返回篡改内容的键（模拟存储层损坏） */
  readonly corruptRead = new Map<string, string>();

  getItem(key: string): string | null {
    this.ops.push(`get:${key}`);
    if (this.failGet.has(key)) throw new Error('getItem blocked');
    const tampered = this.corruptRead.get(key);
    if (tampered !== undefined) return tampered;
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.ops.push(`set:${key}`);
    if (this.failSet.has(key)) throw new Error('quota exceeded');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.ops.push(`rm:${key}`);
    this.map.delete(key);
  }
}

interface Counter {
  n: number;
}

/** 三段版本链的测试 schema：v0 裸数据 {old} → v1 {n} → v2 {n×10} */
function counterSchema(overrides: Partial<StoreSchema<Counter>> = {}): StoreSchema<Counter> {
  return {
    key: 'test.counter',
    version: 2,
    empty: () => ({ n: 0 }),
    validate: (d) =>
      typeof d === 'object' && d !== null && typeof (d as Counter).n === 'number'
        ? { n: (d as Counter).n }
        : null,
    migrations: {
      0: (d) => ({ n: (d as { old: number }).old }),
      1: (d) => ({ n: (d as Counter).n * 10 }),
    },
    ...overrides,
  };
}

const TMP = tmpKeyOf('test.counter');

describe('迁移链', () => {
  it('旧版无信封数据视为版本 0，沿迁移链逐级升级到当前版本', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ old: 5 }));
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 50 }); // v0 {old:5} → v1 {n:5} → v2 {n:50}
    expect(r.migrated).toBe(true);
    expect(r.quarantined).toBeNull();
  });

  it('中间版本信封只执行剩余迁移', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ v: 1, data: { n: 3 } }));
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 30 });
    expect(r.migrated).toBe(true);
  });

  it('当前版本信封原样读取，不标记迁移', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ v: 2, data: { n: 7 } }));
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 7 });
    expect(r.migrated).toBe(false);
  });

  it('迁移后的保存落盘为当前版本信封', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ old: 5 }));
    const r = loadStore(counterSchema(), storage);
    expect(saveStore(counterSchema(), r.value, storage)).toBe(true);
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 50 } });
  });
});

describe('未知版本与损坏数据隔离', () => {
  it('版本号高于当前：隔离并回退默认值，不阻塞启动', () => {
    const storage = new MockStorage();
    const raw = JSON.stringify({ v: 99, data: { n: 1 } });
    storage.map.set('test.counter', raw);
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 0 });
    expect(r.quarantined?.reason).toBe('unknown-version');
    expect(r.quarantined?.version).toBe(99);
    expect(r.quarantined?.raw).toBe(raw); // 原文保留在诊断记录中
    expect(storage.map.has('test.counter')).toBe(false); // 原键已移除
  });

  it('非 JSON 内容按 parse-error 隔离', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', '{oops');
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 0 });
    expect(r.quarantined?.reason).toBe('parse-error');
  });

  it('结构校验失败按 validation-error 隔离', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ v: 2, data: { n: 'x' } }));
    const r = loadStore(counterSchema(), storage);
    expect(r.quarantined?.reason).toBe('validation-error');
    expect(r.quarantined?.version).toBe(2);
  });

  it('迁移函数抛错按 migration-error 隔离', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ v: 1, data: { n: 1 } }));
    const schema = counterSchema({
      migrations: {
        1: () => {
          throw new Error('boom');
        },
      },
    });
    const r = loadStore(schema, storage);
    expect(r.quarantined?.reason).toBe('migration-error');
    expect(r.value).toEqual({ n: 0 });
  });

  it('迁移链缺失同样按 migration-error 隔离', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ v: 1, data: { n: 1 } }));
    const r = loadStore(counterSchema({ migrations: {} }), storage);
    expect(r.quarantined?.reason).toBe('migration-error');
  });

  it('非法版本号（小数 / 负数）按 validation-error 隔离', () => {
    for (const v of [1.5, -1]) {
      const storage = new MockStorage();
      storage.map.set('test.counter', JSON.stringify({ v, data: { n: 1 } }));
      const r = loadStore(counterSchema(), storage);
      expect(r.quarantined?.reason).toBe('validation-error');
      expect(r.value).toEqual({ n: 0 });
    }
  });

  it('隔离记录持久化到诊断键：可查询、可下载、可清除', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', '{oops');
    loadStore(counterSchema(), storage);
    const records = getQuarantineRecords(storage);
    expect(records).toHaveLength(1);
    expect(records[0].key).toBe('test.counter');
    expect(records[0].reason).toBe('parse-error');
    expect(records[0].raw).toBe('{oops');
    expect(records[0].at).toBeTruthy();
    const diag = JSON.parse(buildDiagnostics(storage));
    expect(diag.app).toBe('url-route-debugger');
    expect(diag.records).toHaveLength(1);
    dismissQuarantineRecords(storage);
    expect(getQuarantineRecords(storage)).toEqual([]);
    expect(storage.map.has(DIAGNOSTICS_KEY)).toBe(false);
  });

  it('诊断记录超过上限时只保留最新若干条', () => {
    const storage = new MockStorage();
    for (let i = 0; i < 15; i++) {
      storage.map.set('test.counter', `{bad-${i}`);
      loadStore(counterSchema(), storage);
    }
    const records = getQuarantineRecords(storage);
    expect(records).toHaveLength(10);
    expect(records[0].raw).toBe('{bad-5');
    expect(records[records.length - 1].raw).toBe('{bad-14');
  });
});

describe('临时键恢复（刷新 / 崩溃打断写入）', () => {
  it('主键缺失 + 临时键有效：从临时键恢复并提升为主键', () => {
    const storage = new MockStorage();
    const text = JSON.stringify({ v: 2, data: { n: 9 } });
    storage.map.set(TMP, text);
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 9 });
    expect(r.recoveredFromTmp).toBe(true);
    expect(storage.map.get('test.counter')).toBe(text); // 已提升为主键
    expect(storage.map.has(TMP)).toBe(false); // 临时键已清理
  });

  it('主键损坏 + 临时键有效：隔离主键后以临时键为准', () => {
    const storage = new MockStorage();
    const text = JSON.stringify({ v: 2, data: { n: 4 } });
    storage.map.set('test.counter', '{corrupt');
    storage.map.set(TMP, text);
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 4 });
    expect(r.recoveredFromTmp).toBe(true);
    expect(r.quarantined?.reason).toBe('parse-error');
    expect(r.quarantined?.key).toBe('test.counter');
    expect(storage.map.get('test.counter')).toBe(text);
  });

  it('主键有效 + 临时键内容一致：直接清理临时键', () => {
    const storage = new MockStorage();
    const text = JSON.stringify({ v: 2, data: { n: 7 } });
    storage.map.set('test.counter', text);
    storage.map.set(TMP, text);
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 7 });
    expect(r.recoveredFromTmp).toBe(false);
    expect(storage.map.has(TMP)).toBe(false);
  });

  it('主键有效 + 临时键更新：临时键是未完成的新写入，以它为准', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', JSON.stringify({ v: 2, data: { n: 1 } }));
    storage.map.set(TMP, JSON.stringify({ v: 2, data: { n: 2 } }));
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 2 });
    expect(r.recoveredFromTmp).toBe(true);
  });

  it('主键与临时键都损坏：都隔离，回退默认值，不抛出', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', '{bad-main');
    storage.map.set(TMP, '{bad-tmp');
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 0 });
    expect(storage.map.has('test.counter')).toBe(false);
    expect(storage.map.has(TMP)).toBe(false);
    expect(getQuarantineRecords(storage)).toHaveLength(2);
  });
});

describe('写入顺序（临时键 → 读回校验 → 替换主键）', () => {
  it('操作顺序：先写临时键并读回校验，通过后替换主键再清理', () => {
    const storage = new MockStorage();
    expect(saveStore(counterSchema(), { n: 1 }, storage)).toBe(true);
    expect(storage.ops).toEqual([
      `set:${TMP}`,
      `get:${TMP}`,
      'set:test.counter',
      `rm:${TMP}`,
    ]);
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 1 } });
  });

  it('连续两次写入：后写覆盖先写，各自完整成序，无残留临时键', () => {
    const storage = new MockStorage();
    saveStore(counterSchema(), { n: 1 }, storage);
    saveStore(counterSchema(), { n: 2 }, storage);
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 2 } });
    expect(storage.map.has(TMP)).toBe(false);
    // 每次写入都是完整的「临时键 → 主键」序列，两次之间不交错
    expect(storage.ops.filter((op) => op.startsWith('set:'))).toEqual([
      `set:${TMP}`,
      'set:test.counter',
      `set:${TMP}`,
      'set:test.counter',
    ]);
  });

  it('主键写入失败：返回 false，主键保持旧值，临时键保留供下次启动恢复', () => {
    const storage = new MockStorage();
    saveStore(counterSchema(), { n: 1 }, storage);
    storage.failSet.add('test.counter');
    expect(saveStore(counterSchema(), { n: 2 }, storage)).toBe(false);
    // 主键仍是上一份完整数据，不出现半写入状态
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 1 } });
    expect(storage.map.has(TMP)).toBe(true); // 新值留在临时键
    // 刷新后启动：从临时键恢复新值
    storage.failSet.clear();
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 2 });
    expect(r.recoveredFromTmp).toBe(true);
  });

  it('临时键写入失败：返回 false，主键不变', () => {
    const storage = new MockStorage();
    saveStore(counterSchema(), { n: 1 }, storage);
    storage.failSet.add(TMP);
    expect(saveStore(counterSchema(), { n: 2 }, storage)).toBe(false);
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 1 } });
  });

  it('读回校验失败（存储层篡改了内容）：返回 false，主键不变', () => {
    const storage = new MockStorage();
    saveStore(counterSchema(), { n: 1 }, storage);
    storage.corruptRead.set(TMP, '{"v":2,"data":{"n":999');
    expect(saveStore(counterSchema(), { n: 2 }, storage)).toBe(false);
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 1 } });
  });

  it('不同存储键的写入互不干扰（各自独立的临时键）', () => {
    const storage = new MockStorage();
    const other = counterSchema({ key: 'test.other' });
    saveStore(counterSchema(), { n: 1 }, storage);
    saveStore(other, { n: 2 }, storage);
    expect(JSON.parse(storage.map.get('test.counter')!)).toEqual({ v: 2, data: { n: 1 } });
    expect(JSON.parse(storage.map.get('test.other')!)).toEqual({ v: 2, data: { n: 2 } });
  });

  it('模拟刷新打断写入：只完成临时键阶段，启动时恢复完整新值', () => {
    const storage = new MockStorage();
    saveStore(counterSchema(), { n: 1 }, storage);
    // 手工重演一次被刷新打断的写入：临时键已写好，主键尚未替换
    storage.map.set(TMP, JSON.stringify({ v: 2, data: { n: 2 } }));
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 2 });
    expect(storage.map.get('test.counter')).toBe(JSON.stringify({ v: 2, data: { n: 2 } }));
  });
});

describe('存储不可用时不阻塞启动', () => {
  it('读取抛错：回退默认值，不抛出', () => {
    const storage = new MockStorage();
    storage.failGet.add('test.counter');
    const r = loadStore(counterSchema(), storage);
    expect(r.value).toEqual({ n: 0 });
    expect(r.quarantined).toBeNull();
  });

  it('读写全部抛错：load / save / 诊断查询都不抛出', () => {
    const storage = new MockStorage();
    storage.map.set('test.counter', '{corrupt');
    storage.failSet.add(DIAGNOSTICS_KEY); // 诊断写不进去
    storage.failSet.add('test.counter');
    storage.failSet.add(TMP);
    let r!: ReturnType<typeof loadStore<Counter>>;
    expect(() => {
      r = loadStore(counterSchema(), storage);
    }).not.toThrow();
    expect(r.value).toEqual({ n: 0 });
    expect(r.quarantined?.reason).toBe('parse-error'); // 记录仍返回给调用方
    expect(saveStore(counterSchema(), { n: 1 }, storage)).toBe(false);
    expect(() => buildDiagnostics(storage)).not.toThrow();
  });
});

describe('现有存储键兼容（真实 schema）', () => {
  // 当前线上格式的旧版数据：裸规则数组，无信封，且无 query 字段
  const legacyRule = {
    id: 'r1',
    name: '旧博客 301',
    enabled: true,
    method: 'GET',
    host: 'blog.example.com',
    pathTemplate: '/posts/:slug',
    action: { type: 'redirect', target: 'https://www.example.com/blog/:slug', status: 301 },
  };

  it('规则表：旧版裸数组直接加载并标记迁移，缺失字段按默认补齐', () => {
    const storage = new MockStorage();
    storage.map.set(RULES_STORAGE_KEY, JSON.stringify([legacyRule]));
    const r = loadStore(rulesStore, storage);
    expect(r.migrated).toBe(true);
    expect(r.quarantined).toBeNull();
    expect(r.value).toHaveLength(1);
    expect(r.value[0].id).toBe('r1');
    expect(r.value[0].query).toEqual([]); // 旧数据缺的 query 按空条件处理
  });

  it('规则表：损坏数据隔离后回退到示例规则（拷贝而非共享引用）', () => {
    const storage = new MockStorage();
    storage.map.set(RULES_STORAGE_KEY, '{"not":"rules"}');
    const r = loadStore(rulesStore, storage);
    expect(r.quarantined?.reason).toBe('validation-error');
    expect(r.value).toEqual(SAMPLE_RULES);
    expect(r.value).not.toBe(SAMPLE_RULES);
    expect(getQuarantineRecords(storage)[0].raw).toBe('{"not":"rules"}');
  });

  it('规则表：保存为信封格式，再次加载不迁移', () => {
    const storage = new MockStorage();
    expect(saveStore(rulesStore, SAMPLE_RULES, storage)).toBe(true);
    const stored = JSON.parse(storage.map.get(RULES_STORAGE_KEY)!);
    expect(stored.v).toBe(1);
    expect(Array.isArray(stored.data)).toBe(true);
    const r = loadStore(rulesStore, storage);
    expect(r.migrated).toBe(false);
    expect(r.value).toEqual(SAMPLE_RULES);
  });

  it('回归存储：旧版裸对象（基线 + 用例）直接加载', () => {
    const storage = new MockStorage();
    const legacy = {
      baseline: { rules: [legacyRule], frozenAt: '2026-09-18T00:00:00.000Z' },
      cases: [{ id: 'c1', method: 'GET', url: 'http://example.com/a' }],
    };
    storage.map.set(REGRESSION_STORAGE_KEY, JSON.stringify(legacy));
    const r = loadStore(regressionStore, storage);
    expect(r.migrated).toBe(true);
    expect(r.value.baseline?.rules).toHaveLength(1);
    expect(r.value.baseline?.frozenAt).toBe('2026-09-18T00:00:00.000Z');
    expect(r.value.cases).toEqual([{ id: 'c1', method: 'GET', url: 'http://example.com/a' }]);
  });

  it('回归存储：顶层垃圾被隔离，回退为空', () => {
    const storage = new MockStorage();
    storage.map.set(REGRESSION_STORAGE_KEY, '[1,2,3]');
    const r = loadStore(regressionStore, storage);
    expect(r.quarantined?.reason).toBe('validation-error');
    expect(r.value).toEqual({ baseline: null, cases: [] });
  });

  it('回归存储：保存 / 加载往返一致', () => {
    const storage = new MockStorage();
    const store = {
      baseline: {
        rules: validateRules([legacyRule]),
        frozenAt: '2026-09-26T00:00:00.000Z',
      },
      cases: [{ id: 'c1', method: 'POST', url: 'http://example.com/x' }],
    };
    expect(saveStore(regressionStore, store, storage)).toBe(true);
    const r = loadStore(regressionStore, storage);
    expect(r.migrated).toBe(false);
    expect(r.value).toEqual(store);
  });
});
