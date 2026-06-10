/**
 * Agent core (Phase 2) public surface. Phase 4's control surface imports from
 * here. The LLM only runs inside the executor; the planner and all gates are
 * deterministic.
 */
export { runGoal } from "./run";
export { planTasks } from "./planner";
export { runGates } from "./gates";
export { executeTask } from "./executor";
export { l4Verify } from "./verify";
export {
  applyEntries,
  makeShopifyOps,
  type ApplyItem,
  type ThemeAssetOps,
} from "./apply";
export {
  makeBreakers,
  recordOutcome,
  recordRollbackFailure,
  tripped,
  DEFAULT_BREAKER_CONFIG,
} from "./breakers";
export {
  createRun,
  recordAction,
  finishRun,
  readControl,
  saveResolvedUrls,
  setControl,
} from "./audit";
export {
  classifyPageType,
  requirementsForPage,
  requirementsForTarget,
  uniformRequirements,
  PAGE_TYPE_MATRIX,
  PAGE_TYPE_PRIORITY,
  type PageType,
} from "./page-type-matrix";
export { enumerateCatalogUrls } from "./catalog";
export { gatesPassed } from "./types";
export {
  groupRunPages,
  type RunGroupingInput,
  type RunPageGroups,
} from "./run-grouping";
export type {
  Goal,
  GoalTarget,
  GoalConstraints,
  GoalScope,
  MinOutcome,
  TypeRequirement,
  GateResult,
  GateResults,
  PerceivedPage,
  PlannedTask,
  TaskKind,
  ActionKind,
  ActionRecord,
  ApplyResult,
  ApplyStatus,
  BreakerConfig,
  BreakerReason,
  BreakerState,
  BreakerVerdict,
  AgentPhase,
  HaltSignal,
  AgentProgressEvent,
  RunOptions,
  RunResult,
} from "./types";
