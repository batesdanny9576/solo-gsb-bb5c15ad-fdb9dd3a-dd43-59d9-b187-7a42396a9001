/**
 * 应用各存储键的 schema 定义：规则表、回归基线与用例。
 * 键名沿用既有名称保持兼容；旧版无信封数据视为版本 0，经迁移链升级到当前版本。
 */
import type { Rule } from './types';
import { validateRules } from './validate';
import { validateRegressionStore, type RegressionStore } from './regression';
import { SAMPLE_RULES } from './samples';
import type { StoreSchema } from './persist';

/** 规则表存储键（沿用既有键名） */
export const RULES_STORAGE_KEY = 'url-route-debugger.rules.v1';

/** 回归基线与用例存储键（独立于规则表） */
export const REGRESSION_STORAGE_KEY = 'url-route-debugger.regression.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 规则表 schema。版本历史：
 * - v0（旧版裸数据）：顶层即规则数组，无信封；
 * - v1（当前）：信封 `{ v: 1, data: 规则数组 }`，载荷结构与 v0 一致（迁移为恒等）。
 */
export const rulesStore: StoreSchema<Rule[]> = {
  key: RULES_STORAGE_KEY,
  version: 1,
  empty: () => structuredClone(SAMPLE_RULES),
  validate(data) {
    try {
      return validateRules(data);
    } catch {
      return null;
    }
  },
  migrations: {
    // v0 → v1：载荷结构未变，仅补信封
    0: (data) => data,
  },
};

/**
 * 回归基线与用例 schema。版本历史同规则表：v0 裸对象 → v1 信封，载荷结构未变。
 * 顶层结构明显非法（非对象、字段类型错误）时判定损坏并隔离；
 * 基线 / 用例内部的局部问题仍沿用 validateRegressionStore 的逐项清洗语义。
 */
export const regressionStore: StoreSchema<RegressionStore> = {
  key: REGRESSION_STORAGE_KEY,
  version: 1,
  empty: () => ({ baseline: null, cases: [] }),
  validate(data) {
    if (!isRecord(data)) return null;
    if ('baseline' in data && data.baseline !== null && !isRecord(data.baseline)) return null;
    if ('cases' in data && !Array.isArray(data.cases)) return null;
    return validateRegressionStore(data);
  },
  migrations: {
    // v0 → v1：载荷结构未变，仅补信封
    0: (data) => data,
  },
};
