import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the page processor so the executor receives the exact broken candidates a real
// crawl would hand it (a third-party Event block + a Product with sku-on-Offer and a
// wrong-protocol availability), with NO network or LLM.
vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));

import { processPage } from "@/lib/crawl/process-page";
import { executeTask } from "../executor";
import type { RefineFn } from "../repair";
import type { Goal, PlannedTask } from "../types";

const mockProcess = vi.mocked(processPage);

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeTask self-correction (the 'no longer crashes on first invalid pass')", () => {
  it("stages a clean Product after sanitizing junk + auto-fixing, no LLM call", async () => {
    mockProcess.mockResolvedValue({
      url: task.url,
      status: "errors",
      originalSchemas: null,
      fixedSchemas: [
        { "@type": "Event", name: "Promo" }, // third-party junk
        {
          "@context": "https://schema.org",
          "@type": "Product",
          name: "Molecule Cardholder",
          description: "A minimal leather cardholder.",
          image: "https://pioneercarry.com/img/molecule.jpg",
          offers: {
            "@type": "Offer",
            price: 49,
            priceCurrency: "USD",
            sku: "MOL-001", // wrong object
            availability: "http://schema.org/InStock", // wrong protocol
          },
        },
      ],
      validationResults: null,
    } as unknown as Awaited<ReturnType<typeof processPage>>);

    const refineFn = vi.fn<RefineFn>();
    const result = await executeTask(goal, task, { refineFn });

    expect(result.satisfied).toBe(true);
    expect(result.action.outcome).toBe("staged");
    expect(refineFn).not.toHaveBeenCalled();
    expect(result.entry).not.toBeNull();
    // The Event junk is dropped; only the repaired Product is staged.
    expect(result.entry?.jsonld).toMatchObject({ "@type": "Product", sku: "MOL-001" });
  });

  it("invokes the LLM repair loop and records the self-correction in the outcome", async () => {
    mockProcess.mockResolvedValue({
      url: task.url,
      status: "errors",
      originalSchemas: null,
      // A Product missing its required `offers` — the fixer cannot invent it, so only
      // the LLM repair round can satisfy the gate.
      fixedSchemas: [
        { "@context": "https://schema.org", "@type": "Product", name: "Matter Bifold" },
      ],
      validationResults: null,
    } as unknown as Awaited<ReturnType<typeof processPage>>);

    const refineFn = vi.fn<RefineFn>(async (schema) => ({
      refined: {
        ...(schema as Record<string, unknown>),
        offers: {
          "@type": "Offer",
          price: 79,
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        },
      },
      enhancementNotes: [],
    }));

    const result = await executeTask(goal, task, { refineFn });

    expect(refineFn).toHaveBeenCalledTimes(1);
    expect(result.satisfied).toBe(true);
    expect(result.action.outcome).toContain("self-corrected");
    expect(result.entry).not.toBeNull();
  });

  it("records gate_failed (not a crash) when the page genuinely cannot be fixed", async () => {
    mockProcess.mockResolvedValue({
      url: task.url,
      status: "errors",
      originalSchemas: null,
      fixedSchemas: [
        { "@context": "https://schema.org", "@type": "Product", name: "Flyfold" },
      ],
      validationResults: null,
    } as unknown as Awaited<ReturnType<typeof processPage>>);

    // LLM can't help — returns the same broken schema.
    const refineFn = vi.fn<RefineFn>(async (schema) => ({
      refined: schema as Record<string, unknown>,
      enhancementNotes: [],
    }));

    const result = await executeTask(goal, task, { refineFn });

    expect(result.satisfied).toBe(false);
    expect(result.action.outcome).toBe("gate_failed");
    expect(result.entry).toBeNull();
  });

  it("forwards fetchHeaders to processPage so a gated store can be read in optimize mode", async () => {
    mockProcess.mockResolvedValue({
      url: task.url,
      status: "valid",
      originalSchemas: null,
      fixedSchemas: [
        {
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
        },
      ],
      validationResults: null,
    } as unknown as Awaited<ReturnType<typeof processPage>>);

    await executeTask(goal, task, {
      fetchHeaders: { Cookie: "storefront_digest=xyz" },
    });

    expect(mockProcess).toHaveBeenCalledWith(task.url, "optimize", undefined, {
      fetchHeaders: { Cookie: "storefront_digest=xyz" },
    });
  });
});
