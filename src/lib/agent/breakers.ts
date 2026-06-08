/**
 * Circuit breakers (plan §7 item 4). Pure accumulator — no I/O, no model calls.
 * The run loop reports each page outcome here; `tripped()` says whether to halt.
 * "Never thrash": a failed rollback is terminal and pages the user.
 *
 *   makeBreakers(cfg) ─▶ state
 *   recordOutcome(state, {success, costUsd}) ─▶ mutate counters
 *        success ─▶ consecutiveFailures = 0
 *        failure ─▶ consecutiveFailures += 1
 *        always  ─▶ costUsd += costUsd
 *   recordRollbackFailure(state) ─▶ rollbackFailed = true  (terminal)
 *   tripped(state) ─▶ { halted, reason }
 *        rollbackFailed ............... halt "rollback_failed"  (checked FIRST — most severe)
 *        costUsd > maxCostUsd ......... halt "max_cost_exceeded"
 *        consecutiveFailures >= max ... halt "consecutive_failures"
 *
 * D3: the cost breaker is a tested MECHANISM; production costUsd is 0 until token
 * accounting lands in Phase 5, so it only trips against injected costs for now.
 */
import type {
  BreakerConfig,
  BreakerState,
  BreakerVerdict,
} from "./types";

/** Sensible defaults; callers override via RunOptions / goal.constraints. */
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  maxConsecutiveFailures: 3,
};

export function makeBreakers(
  config: Partial<BreakerConfig> = {}
): BreakerState {
  return {
    config: { ...DEFAULT_BREAKER_CONFIG, ...config },
    consecutiveFailures: 0,
    costUsd: 0,
    rollbackFailed: false,
  };
}

export interface PageOutcome {
  success: boolean;
  /** Cost incurred for this page (USD). Defaults to 0. */
  costUsd?: number;
}

/** Fold one page's outcome into the breaker state. */
export function recordOutcome(state: BreakerState, outcome: PageOutcome): void {
  state.costUsd += outcome.costUsd ?? 0;
  if (outcome.success) {
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures += 1;
  }
}

/** Mark that a rollback itself failed — the theme is dirty; halt and page. */
export function recordRollbackFailure(state: BreakerState): void {
  state.rollbackFailed = true;
}

/**
 * Has a breaker tripped? Most-severe reason wins (a dirty theme outranks a budget
 * overrun outranks a failure streak), so the halt detail is the one that matters.
 */
export function tripped(state: BreakerState): BreakerVerdict {
  if (state.rollbackFailed) {
    return {
      halted: true,
      reason: "rollback_failed",
      detail: "a rollback failed; theme left dirty — halting to avoid thrashing",
    };
  }
  const { maxCostUsd, maxConsecutiveFailures } = state.config;
  if (maxCostUsd != null && state.costUsd > maxCostUsd) {
    return {
      halted: true,
      reason: "max_cost_exceeded",
      detail: `cost ${state.costUsd.toFixed(2)} exceeds budget ${maxCostUsd.toFixed(2)}`,
    };
  }
  if (state.consecutiveFailures >= maxConsecutiveFailures) {
    return {
      halted: true,
      reason: "consecutive_failures",
      detail: `${state.consecutiveFailures} consecutive failures (limit ${maxConsecutiveFailures})`,
    };
  }
  return { halted: false };
}
