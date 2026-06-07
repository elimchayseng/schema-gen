/**
 * Agent core (Phase 2) public surface. Phase 4's control surface imports from
 * here. The LLM only runs inside the executor; the planner and all gates are
 * deterministic.
 */
export { runGoal } from "./run";
export { planTasks } from "./planner";
export { runGates } from "./gates";
export { executeTask } from "./executor";
export { createRun, recordAction, finishRun } from "./audit";
export { gatesPassed } from "./types";
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
  RunOptions,
  RunResult,
} from "./types";
