export type {
  ApplyResult,
  EngineContext,
  ResourceTargetKey,
} from "./engine-types.js";
export { buildPlan, formatPlan } from "./plan-builder.js";
export {
  applyPlan,
  groupActionsByResourceTarget,
} from "./apply-executor.js";
export { buildDriftReport } from "./drift-report.js";
