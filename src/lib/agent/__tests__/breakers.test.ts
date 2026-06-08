import { describe, it, expect } from "vitest";
import {
  DEFAULT_BREAKER_CONFIG,
  makeBreakers,
  recordOutcome,
  recordRollbackFailure,
  tripped,
} from "../breakers";

describe("circuit breakers", () => {
  it("does not halt under all thresholds", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 3, maxCostUsd: 10 });
    recordOutcome(s, { success: false, costUsd: 1 });
    recordOutcome(s, { success: false, costUsd: 1 });
    expect(tripped(s).halted).toBe(false);
  });

  it("halts after N consecutive failures", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 3 });
    recordOutcome(s, { success: false });
    recordOutcome(s, { success: false });
    expect(tripped(s).halted).toBe(false);
    recordOutcome(s, { success: false });
    const v = tripped(s);
    expect(v.halted).toBe(true);
    expect(v.reason).toBe("consecutive_failures");
  });

  it("a success resets the consecutive-failure streak", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 3 });
    recordOutcome(s, { success: false });
    recordOutcome(s, { success: false });
    recordOutcome(s, { success: true }); // reset
    recordOutcome(s, { success: false });
    expect(s.consecutiveFailures).toBe(1);
    expect(tripped(s).halted).toBe(false);
  });

  it("halts when accumulated cost exceeds maxCostUsd (D3 mechanism, injected cost)", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 99, maxCostUsd: 5 });
    recordOutcome(s, { success: true, costUsd: 3 });
    expect(tripped(s).halted).toBe(false); // 3 <= 5
    recordOutcome(s, { success: true, costUsd: 2.5 }); // total 5.5 > 5
    const v = tripped(s);
    expect(v.halted).toBe(true);
    expect(v.reason).toBe("max_cost_exceeded");
  });

  it("does not trip cost when exactly at budget (strict >)", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 99, maxCostUsd: 5 });
    recordOutcome(s, { success: true, costUsd: 5 });
    expect(tripped(s).halted).toBe(false);
  });

  it("cost breaker is inert when maxCostUsd is unset", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 99 });
    recordOutcome(s, { success: true, costUsd: 1000 });
    expect(tripped(s).halted).toBe(false);
  });

  it("a failed rollback is terminal and pages (highest priority)", () => {
    const s = makeBreakers({ maxConsecutiveFailures: 3, maxCostUsd: 1 });
    // Even with other breakers also tripped, rollback_failed wins.
    recordOutcome(s, { success: false, costUsd: 100 });
    recordRollbackFailure(s);
    const v = tripped(s);
    expect(v.halted).toBe(true);
    expect(v.reason).toBe("rollback_failed");
  });

  it("defaults: 3 consecutive failures, no cost cap", () => {
    expect(DEFAULT_BREAKER_CONFIG.maxConsecutiveFailures).toBe(3);
    expect(DEFAULT_BREAKER_CONFIG.maxCostUsd).toBeUndefined();
    const s = makeBreakers();
    recordOutcome(s, { success: false, costUsd: 1e9 });
    expect(tripped(s).halted).toBe(false); // no cost cap by default
  });
});
