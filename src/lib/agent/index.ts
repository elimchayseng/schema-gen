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
  setControl,
} from "./audit";
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
