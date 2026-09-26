/**
 * 版本化持久化层：统一规则表、回归基线与用例的浏览器存储。
 *
 * - 每个存储键声明一份 schema：当前版本号、校验器、迁移链与回退值；
 * - 磁盘格式为信封 `{ v, data }`；旧版无信封数据视为版本 0，加载时沿迁移链逐级升级；
 * - 未知版本 / 损坏数据隔离为诊断记录（界面可下载 JSON），应用以回退值继续启动；
 * - 写入走「临时键 → 读回校验 → 替换主键」三步，刷新 / 崩溃不会留下半写入状态，
 *   启动时回收或清理遗留的临时键；
 * - 所有存储访问都不抛出：任何失败回退默认值，绝不阻塞应用启动。
 */

/** 存储接口：与 Web Storage 对齐，测试可注入内存实现 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 隔离原因 */
export type QuarantineReason =
  | 'parse-error' // 内容不是合法 JSON
  | 'validation-error' // JSON 合法但不符合当前版本的结构
  | 'unknown-version' // 版本号高于当前应用（可能由更新版本写入）
  | 'migration-error'; // 迁移链缺失或执行失败

/** 一条隔离记录：原始内容原样保留，供诊断下载与手工恢复 */
export interface QuarantineRecord {
  /** 被隔离的存储键 */
  key: string;
  reason: QuarantineReason;
  /** 检出的版本号；无信封 / 解析失败时为 null */
  version: number | null;
  /** 原始内容原文 */
  raw: string;
  /** ISO 时间戳 */
  at: string;
}

/** 一个存储键的 schema 定义 */
export interface StoreSchema<T> {
  /** 存储键（沿用既有键名，保持兼容） */
  key: string;
  /** 当前 schema 版本；旧版无信封数据视为版本 0 */
  version: number;
  /** 数据缺失或不可恢复时的回退值（工厂函数，避免共享可变实例） */
  empty: () => T;
  /** 校验并规范化当前版本数据；无法使用时返回 null（触发隔离） */
  validate: (data: unknown) => T | null;
  /** 迁移链：migrations[n] 把版本 n 的载荷升级为版本 n+1 */
  migrations?: Record<number, (data: unknown) => unknown>;
}

export interface LoadResult<T> {
  /** 加载结果：迁移后 / 恢复后的值，或回退值 */
  value: T;
  /** 数据从旧版本迁移而来（下次保存自动落盘为当前格式） */
  migrated: boolean;
  /** 本次加载发生隔离时的首条记录（全部记录见 getQuarantineRecords） */
  quarantined: QuarantineRecord | null;
  /** 值来自遗留临时键（上次写入在替换主键前中断） */
  recoveredFromTmp: boolean;
}

/** 诊断记录的存储键（独立于各业务键，本身不做版本迁移，读取时逐条防御性校验） */
export const DIAGNOSTICS_KEY = 'url-route-debugger.diagnostics.v1';

/** 诊断记录上限：只保留最近若干条，避免异常反复隔离时无限增长 */
const MAX_DIAGNOSTIC_RECORDS = 10;

/** 临时键命名：与主键一一对应 */
export function tmpKeyOf(key: string): string {
  return `${key}.tmp`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // 忽略：清理失败不影响主流程
  }
}

/** 进程内回退存储：localStorage 不可用（隐私模式等）时退化为会话级内存存储 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

let memoryFallback: StorageLike | null = null;

/** 默认存储：localStorage 不可访问时退化为内存存储，绝不抛出 */
export function defaultStorage(): StorageLike {
  try {
    const ls = globalThis.localStorage;
    if (ls != null) return ls;
  } catch {
    // 某些环境（如禁用 Cookie 的隐私模式）访问 localStorage 本身即抛错
  }
  if (memoryFallback === null) memoryFallback = memoryStorage();
  return memoryFallback;
}

type DecodeResult<T> =
  | { ok: true; value: T; migrated: boolean }
  | { ok: false; reason: QuarantineReason; version: number | null };

/** 解析 → 识别版本 → 沿迁移链升级 → 校验；失败时给出隔离原因 */
function decode<T>(schema: StoreSchema<T>, raw: string): DecodeResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'parse-error', version: null };
  }

  // 信封 `{ v, data }` 为版本化格式；否则视为版本 0 的旧版裸数据
  let version = 0;
  let payload = parsed;
  if (isRecord(parsed) && typeof parsed.v === 'number' && 'data' in parsed) {
    version = parsed.v;
    payload = parsed.data;
    if (!Number.isInteger(version) || version < 0) {
      return { ok: false, reason: 'validation-error', version: null };
    }
    if (version > schema.version) {
      return { ok: false, reason: 'unknown-version', version };
    }
  }

  try {
    for (let v = version; v < schema.version; v++) {
      const step = schema.migrations?.[v];
      if (step === undefined) {
        return { ok: false, reason: 'migration-error', version };
      }
      payload = step(payload);
    }
  } catch {
    return { ok: false, reason: 'migration-error', version };
  }

  const value = schema.validate(payload);
  if (value === null) {
    return { ok: false, reason: 'validation-error', version };
  }
  return { ok: true, value, migrated: version !== schema.version };
}

const QUARANTINE_REASONS: readonly QuarantineReason[] = [
  'parse-error',
  'validation-error',
  'unknown-version',
  'migration-error',
];

function toQuarantineRecord(v: unknown): QuarantineRecord | null {
  if (!isRecord(v)) return null;
  if (typeof v.key !== 'string' || typeof v.raw !== 'string' || typeof v.at !== 'string') {
    return null;
  }
  if (typeof v.reason !== 'string' || !(QUARANTINE_REASONS as readonly string[]).includes(v.reason)) {
    return null;
  }
  return {
    key: v.key,
    reason: v.reason as QuarantineReason,
    version: typeof v.version === 'number' ? v.version : null,
    raw: v.raw,
    at: v.at,
  };
}

/** 读取全部隔离记录（诊断键损坏或缺失时返回空数组） */
export function getQuarantineRecords(storage: StorageLike = defaultStorage()): QuarantineRecord[] {
  const raw = safeGet(storage, DIAGNOSTICS_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) return [];
    return parsed.records
      .map(toQuarantineRecord)
      .filter((r): r is QuarantineRecord => r !== null);
  } catch {
    return [];
  }
}

/** 清除全部隔离记录（用户在提示条上选择「忽略并清除」） */
export function dismissQuarantineRecords(storage: StorageLike = defaultStorage()): void {
  safeRemove(storage, DIAGNOSTICS_KEY);
}

/**
 * 隔离一份无法读取的数据：记录诊断信息（持久化到诊断键，刷新后仍可下载），
 * 并从原键移除，让应用以回退值继续启动。诊断写入失败时静默跳过。
 */
function quarantine(
  storage: StorageLike,
  key: string,
  raw: string,
  reason: QuarantineReason,
  version: number | null,
): QuarantineRecord {
  const record: QuarantineRecord = {
    key,
    reason,
    version,
    raw,
    at: new Date().toISOString(),
  };
  const records = [...getQuarantineRecords(storage), record].slice(-MAX_DIAGNOSTIC_RECORDS);
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify({ records }));
  safeRemove(storage, key);
  return record;
}

/**
 * 加载一个存储键：解析、迁移、校验，处理遗留临时键与损坏数据。
 * 任何情况下都不抛出；不可恢复时返回 schema.empty()。
 */
export function loadStore<T>(
  schema: StoreSchema<T>,
  storage: StorageLike = defaultStorage(),
): LoadResult<T> {
  const tmpKey = tmpKeyOf(schema.key);
  const raw = safeGet(storage, schema.key);
  const tmpRaw = safeGet(storage, tmpKey);
  let quarantined: QuarantineRecord | null = null;

  // 遗留临时键：上次写入在「替换主键」前后被刷新 / 崩溃打断。
  // 临时键不旧于主键（每次写入都先覆盖临时键）：
  // 与主键一致 → 崩溃发生在清理前，直接清理；不一致且有效 → 以较新的临时键为准恢复；
  // 临时键损坏 → 隔离后继续走主键。
  if (tmpRaw !== null) {
    if (tmpRaw === raw) {
      safeRemove(storage, tmpKey);
    } else {
      const fromTmp = decode(schema, tmpRaw);
      if (fromTmp.ok) {
        if (raw !== null) {
          const fromMain = decode(schema, raw);
          if (!fromMain.ok) {
            quarantined = quarantine(storage, schema.key, raw, fromMain.reason, fromMain.version);
          }
        }
        safeSet(storage, schema.key, tmpRaw);
        safeRemove(storage, tmpKey);
        return { value: fromTmp.value, migrated: fromTmp.migrated, quarantined, recoveredFromTmp: true };
      }
      quarantined = quarantine(storage, tmpKey, tmpRaw, fromTmp.reason, fromTmp.version);
    }
  }

  if (raw === null) {
    return { value: schema.empty(), migrated: false, quarantined, recoveredFromTmp: false };
  }
  const fromMain = decode(schema, raw);
  if (!fromMain.ok) {
    quarantined = quarantine(storage, schema.key, raw, fromMain.reason, fromMain.version);
    return { value: schema.empty(), migrated: false, quarantined, recoveredFromTmp: false };
  }
  return { value: fromMain.value, migrated: fromMain.migrated, quarantined, recoveredFromTmp: false };
}

/**
 * 保存一个存储键：先写临时键，读回校验通过后才替换主键，再清理临时键。
 * 任一步失败都返回 false，主键保持上一份完整数据，临时键保留供下次启动恢复；
 * 调用方无需 try/catch，存储不可用（配额 / 隐私模式）时静默失败。
 */
export function saveStore<T>(
  schema: StoreSchema<T>,
  value: T,
  storage: StorageLike = defaultStorage(),
): boolean {
  let text: string;
  try {
    text = JSON.stringify({ v: schema.version, data: value });
  } catch {
    return false; // 无法序列化（如循环引用）：保持磁盘原值不变
  }
  const tmpKey = tmpKeyOf(schema.key);
  try {
    storage.setItem(tmpKey, text);
    // 读回校验：确认落盘内容完整且符合 schema，再替换主键
    const back = storage.getItem(tmpKey);
    if (back !== text || !decode(schema, text).ok) return false;
    storage.setItem(schema.key, text);
    storage.removeItem(tmpKey);
    return true;
  } catch {
    return false;
  }
}

/** 生成可下载的诊断 JSON：应用标识、生成时间、UA 与全部隔离记录 */
export function buildDiagnostics(storage: StorageLike = defaultStorage()): string {
  return JSON.stringify(
    {
      app: 'url-route-debugger',
      generatedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      records: getQuarantineRecords(storage),
    },
    null,
    2,
  );
}
