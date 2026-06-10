/**
 * Sticky merchant overrides in the executor (issue #29 wiring). After the repair
 * loop produces the candidate JSON-LD, the executor best-effort loads the page's
 * stored overrides and deterministically merges them BEFORE the gates evaluate —
 * so a merchant correction always wins over a regenerate, and a load failure is
 * byte-identical to "no overrides".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));
// Mock ONLY the persistence read; applyOverrides stays the real pure merge.
vi.mock("../overrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../overrides")>()),
  loadOverrides: vi.fn(),
}));

import { processPage } from "@/lib/crawl/process-page";
import { loadOverrides, type MerchantOverride } from "../overrides";
import { executeTask } from "../executor";
import type { Goal, PlannedTask } from "../types";

const mockProcess = vi.mocked(processPage);
const mockLoad = vi.mocked(loadOverrides);

const goal: Goal = {
  siteId: "site-1",
  target: {
    scope: "all_products",
    requireTypes: ["Product"],
    minOutcome: "rich_results_eligible",
  },
  constraints: { allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

const task: PlannedTask = {
  url: "https://pioneercarry.com/products/molecule-cardholder",
  kind: "fix",
  beforeErrorCount: 5,
  beforeHadSchema: true,
};

const VALID_PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Molecule Cardholder",
  description: "A minimal leather cardholder.",
  image: "https://pioneercarry.com/img/molecule.jpg",
  offers: {
    "@type": "Offer",
    price: 49,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
};

const override = (
  fieldPath: string,
  value: unknown,
  schemaType = "Product"
): MerchantOverride => ({
  id: "ov-1",
  siteId: "site-1",
  url: task.url,
  schemaType,
  fieldPath,
  value,
  source: "chat",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockProcess.mockResolvedValue({
    url: task.url,
    status: "valid",
    originalSchemas: null,
    fixedSchemas: [structuredClone(VALID_PRODUCT)],
    validationResults: null,
  } as unknown as Awaited<ReturnType<typeof processPage>>);
});

describe("executeTask sticky merchant overrides (issue #29)", () => {
  it("applies stored overrides onto the candidate the gates evaluate and stage", async () => {
    mockLoad.mockResolvedValue([
      override("name", "Molecule Cardholder — Horween Leather"),
      override("brand.name", "Pioneer Carry"),
    ]);

    const result = await executeTask(goal, task);

    expect(mockLoad).toHaveBeenCalledWith("site-1", task.url);
    expect(result.satisfied).toBe(true);
    // The override values appear in the staged entry (merchant wins over regenerate).
    expect(result.entry?.jsonld).toMatchObject({
      "@type": "Product",
      name: "Molecule Cardholder — Horween Leather",
      brand: { name: "Pioneer Carry" },
    });
    // The audit outcome records how many overrides were applied.
    expect(result.action.outcome).toBe("staged, overrides:2");
    expect(result.action.schemaAfter).toMatchObject([
      { name: "Molecule Cardholder — Horween Leather" },
    ]);
  });

  it("a loadOverrides failure is identical to no-overrides (never fails the task)", async () => {
    mockLoad.mockRejectedValue(new Error("SUPABASE_SERVICE_ROLE_KEY is not set"));

    const result = await executeTask(goal, task);

    expect(result.satisfied).toBe(true);
    expect(result.action.outcome).toBe("staged"); // no ", overrides:N" suffix
    expect(result.entry?.jsonld).toMatchObject({ name: "Molecule Cardholder" });
  });

  it("zero stored overrides → no suffix, candidate untouched", async () => {
    mockLoad.mockResolvedValue([]);

    const result = await executeTask(goal, task);

    expect(result.satisfied).toBe(true);
    expect(result.action.outcome).toBe("staged");
    expect(result.entry?.jsonld).toMatchObject({ name: "Molecule Cardholder" });
  });

  it("overrides that only conflict (no matching node) leave outcome and candidate unchanged", async () => {
    mockLoad.mockResolvedValue([
      override("name", "Wrong", "Event"), // no Event node in the document
    ]);

    const result = await executeTask(goal, task);

    expect(result.satisfied).toBe(true);
    expect(result.action.outcome).toBe("staged");
    expect(result.entry?.jsonld).toMatchObject({ name: "Molecule Cardholder" });
  });

  it("re-gates the OVERRIDDEN document — a merchant override that breaks validity fails the gates", async () => {
    // Blanking the required `name` invalidates the Product → gates must catch it.
    mockLoad.mockResolvedValue([override("name", "")]);

    const result = await executeTask(goal, task);

    expect(result.satisfied).toBe(false);
    expect(result.entry).toBeNull();
    expect(result.action.outcome).toBe("gate_failed, overrides:1");
  });
});
