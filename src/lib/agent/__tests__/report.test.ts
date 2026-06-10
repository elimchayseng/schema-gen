import { describe, it, expect } from "vitest";
import {
  buildMerchantReport,
  googleRichResultsUrl,
  GOOGLE_PROOF_LABEL,
  SCHEMAGEN_PROOF_LABEL,
  type AgentActionRow,
  type AgentRunRow,
} from "../report";
import type { GateResults } from "../types";

// ---- Fixtures ----

const PRODUCT_A = "https://shop.example.com/products/a";
const PRODUCT_B = "https://shop.example.com/products/b";
const PRODUCT_C = "https://shop.example.com/products/c";

function makeRun(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: "run-1",
    site_id: "site-1",
    goal: {
      target: {
        scope: "all_products",
        requireTypes: ["Product"],
        minOutcome: "rich_results_eligible",
      },
    },
    status: "done",
    pages_touched: 2,
    cost_usd: 0,
    started_at: "2026-06-09T10:00:00Z",
    ended_at: "2026-06-09T10:05:00Z",
    error: null,
    ...overrides,
  };
}

function passingGates(): GateResults {
  return {
    L0: { passed: true },
    L1: { passed: true },
    L2: { passed: true },
    L3: { passed: true },
  };
}

let seq = 0;
function row(overrides: Partial<AgentActionRow>): AgentActionRow {
  seq += 1;
  return {
    url: PRODUCT_A,
    action: "fix",
    schema_before: null,
    schema_after: null,
    gates: null,
    write_target: null,
    outcome: "staged",
    created_at: `2026-06-09T10:00:${String(seq).padStart(2, "0")}Z`,
    ...overrides,
  };
}

function skipRow(url: string, outcome: string): AgentActionRow {
  return row({ url, action: "skip", outcome });
}

function actRow(
  url: string,
  kind: "fix" | "generate",
  outcome = "staged",
  extra: Partial<AgentActionRow> = {}
): AgentActionRow {
  return row({
    url,
    action: kind,
    outcome,
    gates: passingGates(),
    schema_after: [{ "@type": "Product", name: "A" }],
    ...extra,
  });
}

function verifyRow(url: string, pass: boolean, detail?: string): AgentActionRow {
  return row({
    url,
    action: "verify",
    outcome: pass ? "l4_pass" : "l4_fail",
    write_target: "123456",
    gates: {
      L0: { passed: true },
      L1: { passed: true },
      L2: null,
      L3: { passed: true },
      L4: { passed: pass, ...(detail ? { detail } : {}) },
    },
  });
}

// ---- googleRichResultsUrl ----

describe("googleRichResultsUrl", () => {
  it("deep-links the Rich Results Test with the page url encoded", () => {
    expect(googleRichResultsUrl("https://x.com/p?a=1&b=2")).toBe(
      "https://search.google.com/test/rich-results?url=https%3A%2F%2Fx.com%2Fp%3Fa%3D1%26b%3D2"
    );
  });
});

// ---- buildMerchantReport ----

describe("buildMerchantReport", () => {
  it("carries the run identity, timestamps, and both proof labels verbatim", () => {
    const report = buildMerchantReport(makeRun(), []);
    expect(report.runId).toBe("run-1");
    expect(report.startedAt).toBe("2026-06-09T10:00:00Z");
    expect(report.endedAt).toBe("2026-06-09T10:05:00Z");
    expect(report.proof.schemaGenLabel).toBe(SCHEMAGEN_PROOF_LABEL);
    expect(report.proof.googleLabel).toBe(GOOGLE_PROOF_LABEL);
    expect(report.proof.schemaGenLabel).toContain("Validated by SchemaGen");
    expect(report.proof.googleLabel).toBe("Confirm with Google");
  });

  it("maps skip/already_satisfied to already_good with a true Valid gate", () => {
    const report = buildMerchantReport(makeRun(), [
      skipRow(PRODUCT_A, "already_satisfied"),
    ]);
    expect(report.pages).toHaveLength(1);
    const page = report.pages[0];
    expect(page.disposition).toBe("already_good");
    expect(page.schemaTypes).toEqual(["Product"]);
    expect(page.googleTestUrl).toBe(googleRichResultsUrl(PRODUCT_A));
    const l1 = page.gates.find((g) => g.level === "L1");
    expect(l1?.passed).toBe(true);
    expect(l1?.label).toBe("Valid");
    // rich_results_eligible goal → L2 evaluated true for an already-good page
    expect(page.gates.find((g) => g.level === "L2")?.passed).toBe(true);
    expect(report.summary.alreadyGood).toBe(1);
  });

  it("maps a staged fix with an l4_pass verify to fixed (live-verified)", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "fix", "staged", {
        schema_before: [{ "@type": "Product", name: "old" }],
      }),
      verifyRow(PRODUCT_A, true),
    ]);
    const page = report.pages[0];
    expect(page.disposition).toBe("fixed");
    expect(page.before).toEqual([{ "@type": "Product", name: "old" }]);
    expect(page.after).toEqual([{ "@type": "Product", name: "A" }]);
    const l4 = page.gates.find((g) => g.level === "L4");
    expect(l4?.passed).toBe(true);
    expect(l4?.label).toBe("Live-verified");
    expect(report.summary.fixed).toBe(1);
  });

  it("maps a staged generate with an l4_pass to generated", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "generate"),
      verifyRow(PRODUCT_A, true),
    ]);
    expect(report.pages[0].disposition).toBe("generated");
    expect(report.summary.generated).toBe(1);
  });

  it("maps gate_failed and processing_failed to failed with plain-English reasons", () => {
    const failedGates: GateResults = {
      L0: { passed: true },
      L1: { passed: false, detail: "missing offers.price" },
      L2: null,
      L3: { passed: true },
    };
    const report = buildMerchantReport(makeRun({ status: "failed" }), [
      actRow(PRODUCT_A, "fix", "gate_failed", { gates: failedGates }),
      actRow(PRODUCT_B, "generate", "processing_failed: AI timeout"),
    ]);
    const a = report.pages.find((p) => p.url === PRODUCT_A)!;
    const b = report.pages.find((p) => p.url === PRODUCT_B)!;
    expect(a.disposition).toBe("failed");
    expect(a.failureReason).toContain("did not pass SchemaGen's quality gates");
    expect(a.failureReason).toContain("Valid gate");
    expect(a.failureReason).toContain("missing offers.price");
    expect(b.disposition).toBe("failed");
    expect(b.failureReason).toBe("Processing failed: AI timeout");
    expect(report.summary.failed).toBe(2);
    expect(report.verdict.goodToGo).toBe(false);
  });

  it("a run-level rollback reverts EVERY staged page, not just the failing url", () => {
    const report = buildMerchantReport(makeRun({ status: "failed" }), [
      actRow(PRODUCT_A, "fix"),
      actRow(PRODUCT_B, "fix"),
      verifyRow(PRODUCT_A, true),
      verifyRow(PRODUCT_B, false, "no JSON-LD rendered"),
      row({
        url: PRODUCT_B,
        action: "rollback",
        outcome: "rolled_back: no JSON-LD rendered",
      }),
    ]);
    const a = report.pages.find((p) => p.url === PRODUCT_A)!;
    const b = report.pages.find((p) => p.url === PRODUCT_B)!;
    expect(a.disposition).toBe("rolled_back");
    expect(a.failureReason).toContain("another page failed live verification");
    expect(b.disposition).toBe("rolled_back");
    expect(b.failureReason).toContain("failed live verification");
    expect(b.failureReason).toContain("no JSON-LD rendered");
    expect(report.summary.failed).toBe(2);
    expect(report.verdict.headline).toBe("Needs attention");
    expect(report.verdict.reason).toContain("safely reverted");
  });

  it("rollback_failed marks staged pages failed and adds an URGENT merchant action", () => {
    const report = buildMerchantReport(
      makeRun({ status: "failed", error: "rollback failed; theme left dirty: 500" }),
      [
        actRow(PRODUCT_A, "fix"),
        verifyRow(PRODUCT_A, false),
        row({ url: PRODUCT_A, action: "rollback", outcome: "rollback_failed: 500" }),
      ]
    );
    expect(report.pages[0].disposition).toBe("failed");
    expect(
      report.requiredMerchantActions.some((a) => a.includes("automatic restore failed"))
    ).toBe(true);
    expect(report.verdict.goodToGo).toBe(false);
  });

  it("a staged page with no verify row stays fixed but flags 'not applied live'", () => {
    const report = buildMerchantReport(makeRun(), [actRow(PRODUCT_A, "fix")]);
    const page = report.pages[0];
    expect(page.disposition).toBe("fixed");
    const l4 = page.gates.find((g) => g.level === "L4");
    expect(l4?.passed).toBeNull();
    expect(l4?.detail).toBe("Not applied live yet");
    expect(page.note).toContain("not been applied to your store yet");
    expect(
      report.requiredMerchantActions.some((a) => a.includes("Apply the run live"))
    ).toBe(true);
  });

  it("maps skip/already_committed (idempotent resume) to fixed with a note", () => {
    const report = buildMerchantReport(makeRun(), [
      skipRow(PRODUCT_A, "already_committed"),
    ]);
    expect(report.pages[0].disposition).toBe("fixed");
    expect(report.pages[0].note).toContain("earlier in this run");
    expect(report.pages[0].gates.find((g) => g.level === "L4")?.passed).toBe(true);
  });

  it("url_list goal urls with no action rows become skipped + counted notReached", () => {
    const run = makeRun({
      status: "failed",
      error: "run killed by control signal",
      goal: {
        target: {
          scope: "url_list",
          urls: [PRODUCT_A, PRODUCT_B, PRODUCT_C],
          requireTypes: ["Product"],
          minOutcome: "valid",
        },
      },
    });
    const report = buildMerchantReport(run, [
      skipRow(PRODUCT_A, "already_satisfied"),
      actRow(PRODUCT_B, "fix"),
    ]);
    const c = report.pages.find((p) => p.url === PRODUCT_C)!;
    expect(c.disposition).toBe("skipped");
    expect(c.failureReason).toContain("ended before this page was checked");
    expect(report.summary.notReached).toBe(1);
    expect(report.summary.pagesChecked).toBe(2);
    expect(report.verdict.goodToGo).toBe(false);
  });

  it("resolved_urls (issue #27) makes notReached exact for non-url_list scopes", () => {
    const run = makeRun({
      status: "failed",
      error: "halted by circuit breaker: consecutive_failures",
      goal: {
        target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
      },
      resolved_urls: [PRODUCT_A, PRODUCT_B, PRODUCT_C],
    });
    const report = buildMerchantReport(run, [actRow(PRODUCT_A, "fix")]);

    const notReached = report.pages.filter((p) => p.disposition === "skipped");
    expect(notReached.map((p) => p.url).sort()).toEqual([PRODUCT_B, PRODUCT_C]);
    expect(report.summary.notReached).toBe(2);
    expect(report.verdict.goodToGo).toBe(false);
  });

  it("scope 'site' already-good pages get matrix types, not the goal's requireTypes", () => {
    const run = makeRun({
      goal: {
        target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
      },
    });
    const report = buildMerchantReport(run, [skipRow(PRODUCT_A, "already_satisfied")]);
    expect(report.pages[0].schemaTypes).toEqual(["Product", "BreadcrumbList"]);
  });

  it("uses the LAST act row per url (self-repair re-records)", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "fix", "gate_failed", { gates: passingGates() }),
      actRow(PRODUCT_A, "fix", "staged (self-corrected in 2 passes)"),
      verifyRow(PRODUCT_A, true),
    ]);
    const page = report.pages[0];
    expect(report.pages).toHaveLength(1);
    expect(page.disposition).toBe("fixed");
    expect(page.note).toContain("self-corrected");
  });

  it("extracts schemaTypes from objects, arrays, string-array @type, and @graph", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "generate", "staged", {
        schema_after: [
          { "@type": ["Product", "IndividualProduct"], name: "A" },
          { "@graph": [{ "@type": "BreadcrumbList" }] },
        ],
      }),
    ]);
    expect(report.pages[0].schemaTypes.sort()).toEqual([
      "BreadcrumbList",
      "IndividualProduct",
      "Product",
    ]);
  });

  it("derives the site domain from the first parseable page url", () => {
    const report = buildMerchantReport(makeRun(), [
      skipRow(PRODUCT_A, "already_satisfied"),
    ]);
    expect(report.siteDomain).toBe("shop.example.com");
  });

  it("good-to-go verdict: done run, all pages good, summary tallies match", () => {
    const report = buildMerchantReport(makeRun(), [
      skipRow(PRODUCT_A, "already_satisfied"),
      actRow(PRODUCT_B, "fix", "staged", {
        schema_before: [{ "@type": "Product", name: "old" }],
      }),
      verifyRow(PRODUCT_B, true),
      actRow(PRODUCT_C, "generate"),
      verifyRow(PRODUCT_C, true),
    ]);
    expect(report.verdict.goodToGo).toBe(true);
    expect(report.verdict.headline).toBe("You're good to go");
    expect(report.verdict.reason).toContain("1 already correct");
    expect(report.verdict.reason).toContain("1 fixed");
    expect(report.verdict.reason).toContain("1 newly generated");
    expect(report.summary).toEqual({
      pagesChecked: 3,
      alreadyGood: 1,
      fixed: 1,
      generated: 1,
      failed: 0,
      notReached: 0,
    });
  });

  it("live-applied runs require publishing the staged theme", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "fix"),
      verifyRow(PRODUCT_A, true),
    ]);
    expect(
      report.requiredMerchantActions.some(
        (a) => a.includes("Publish theme 123456") && a.includes("unpublished")
      )
    ).toBe(true);
  });

  it("warns when a fixed page's theme/app still emits the original schema", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "fix", "staged", {
        schema_before: [{ "@type": "Product", name: "duplicate source" }],
      }),
      verifyRow(PRODUCT_A, true),
    ]);
    expect(
      report.requiredMerchantActions.some((a) =>
        a.includes("still emits the original structured data")
      )
    ).toBe(true);
  });

  it("requiredMerchantActions is empty when nothing is needed", () => {
    const report = buildMerchantReport(makeRun(), [
      skipRow(PRODUCT_A, "already_satisfied"),
    ]);
    expect(report.requiredMerchantActions).toEqual([]);
    expect(report.verdict.goodToGo).toBe(true);
  });

  it("a still-running run is never good-to-go and says results are partial", () => {
    const report = buildMerchantReport(makeRun({ status: "running", ended_at: null }), [
      skipRow(PRODUCT_A, "already_satisfied"),
    ]);
    expect(report.verdict.goodToGo).toBe(false);
    expect(report.verdict.reason).toContain("still in progress");
  });

  it("an empty run (no actions) is not good-to-go", () => {
    const report = buildMerchantReport(
      makeRun({ status: "failed", error: "Could not resolve site domain" }),
      []
    );
    expect(report.verdict.goodToGo).toBe(false);
    expect(report.verdict.reason).toContain("did not reach any pages");
    expect(report.pages).toEqual([]);
    expect(report.summary.pagesChecked).toBe(0);
  });

  it("tolerates unsorted action rows (sorts by created_at before folding)", () => {
    const rows = [
      actRow(PRODUCT_A, "fix", "gate_failed"),
      actRow(PRODUCT_A, "fix", "staged"),
      verifyRow(PRODUCT_A, true),
    ];
    const report = buildMerchantReport(makeRun(), [rows[2], rows[1], rows[0]]);
    expect(report.pages[0].disposition).toBe("fixed");
  });

  it("every gate carries its plain-English label in order L0..L4", () => {
    const report = buildMerchantReport(makeRun(), [
      actRow(PRODUCT_A, "fix"),
      verifyRow(PRODUCT_A, true),
    ]);
    expect(report.pages[0].gates.map((g) => `${g.level}:${g.label}`)).toEqual([
      "L0:Built",
      "L1:Valid",
      "L2:Rich-eligible",
      "L3:No-regression",
      "L4:Live-verified",
    ]);
  });
});
