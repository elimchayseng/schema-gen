import { describe, it, expect } from "vitest";
import { planTasks } from "../planner";
import type { Goal, PerceivedPage } from "../types";

const goal = (overrides: Partial<Goal["constraints"]> = {}): Goal => ({
  siteId: "site-1",
  target: { scope: "url_list", requireTypes: ["Product"], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false, ...overrides },
  autonomy: "auto_apply",
});

const page = (
  url: string,
  status: PerceivedPage["status"],
  satisfied: boolean,
  hadSchema: boolean,
  errorCount = 0
): PerceivedPage => ({ url, status, satisfied, hadSchema, errorCount });

describe("planTasks", () => {
  it("never queues an already-satisfied page", () => {
    const { queue, skipped } = planTasks(goal(), [
      page("/a", "valid", true, true),
      page("/b", "errors", false, true, 3),
    ]);
    expect(skipped).toEqual(["/a"]);
    expect(queue.map((t) => t.url)).toEqual(["/b"]);
  });

  it("orders fixes before generations (cheapest/safest first)", () => {
    const { queue } = planTasks(goal(), [
      page("/gen1", "no_schema", false, false),
      page("/fix1", "errors", false, true, 2),
      page("/gen2", "no_schema", false, false),
      page("/fix2", "warnings", false, true, 1),
    ]);
    expect(queue.map((t) => t.kind)).toEqual(["fix", "fix", "generate", "generate"]);
    // stable within a kind: perceived order preserved
    expect(queue.map((t) => t.url)).toEqual(["/fix1", "/fix2", "/gen1", "/gen2"]);
  });

  it("maps no_schema -> generate and carries before-state", () => {
    const { queue } = planTasks(goal(), [page("/c", "no_schema", false, false)]);
    expect(queue[0]).toMatchObject({
      url: "/c",
      kind: "generate",
      beforeHadSchema: false,
      beforeErrorCount: 0,
    });
  });

  it("respects maxPages", () => {
    const { queue } = planTasks(goal({ maxPages: 1 }), [
      page("/fix1", "errors", false, true, 1),
      page("/fix2", "errors", false, true, 1),
    ]);
    expect(queue).toHaveLength(1);
  });
});
