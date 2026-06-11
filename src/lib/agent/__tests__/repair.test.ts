import { describe, it, expect, vi } from "vitest";
import { dedupeCandidatesByType, repairToGoal, sanitizeCandidates } from "../repair";
import type { RefineFn } from "../repair";
import { validateSchema } from "@/lib/validation/engine";

/** A Product with the exact defects seen on the live pioneercarry.com pages: */
/**  - an Event block injected by a third-party app (unknown type) */
/**  - `sku` placed on Offer instead of Product */
/**  - `availability` using the wrong `http://` protocol */
function brokenPioneerCarryCandidates(): Record<string, unknown>[] {
  return [
    { "@context": "https://schema.org", "@type": "Event", name: "Newsletter Signup" },
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Molecule Cardholder",
      description: "A minimal leather cardholder.",
      sku: "MOL-001",
      // image given as an ImageObject, not a URL string (Shopify/Yoast shape)
      image: { "@type": "ImageObject", url: "https://pioneercarry.com/img/molecule.jpg" },
      offers: {
        "@type": "Offer",
        price: 49,
        priceCurrency: "USD",
        sku: "MOL-001", // redundant copy on Offer — must be dropped
        availability: "http://schema.org/InStock", // wrong protocol
      },
    },
  ];
}

const goalInput = {
  url: "https://pioneercarry.com/products/molecule-cardholder",
  requireTypes: ["Product"],
  minOutcome: "rich_results_eligible" as const,
  beforeErrorCount: 5,
  beforeHadSchema: true,
};

describe("sanitizeCandidates", () => {
  it("drops unknown third-party types but keeps known + required types", () => {
    const kept = sanitizeCandidates(brokenPioneerCarryCandidates(), ["Product"]);
    expect(kept).toHaveLength(1);
    expect(kept[0]["@type"]).toBe("Product");
  });

  it("never strips a page to nothing — falls back to the original set", () => {
    const onlyJunk = [{ "@type": "Event", name: "x" }];
    expect(sanitizeCandidates(onlyJunk, ["Product"])).toHaveLength(1);
  });
});

describe("repairToGoal — deterministic path (no LLM needed)", () => {
  it("self-corrects the exact failing example with zero LLM calls", async () => {
    const refineFn = vi.fn<RefineFn>();
    const result = await repairToGoal({
      ...goalInput,
      candidates: brokenPioneerCarryCandidates(),
      refineFn,
    });

    expect(result.satisfied).toBe(true);
    expect(result.gates.L1.passed).toBe(true);
    expect(result.gates.L2?.passed).toBe(true);
    expect(result.attempts).toBe(0); // fixed by sanitize + auto-fix alone
    expect(refineFn).not.toHaveBeenCalled();

    // The Event junk is gone; the Product is valid; sku moved up; protocol fixed.
    expect(result.candidates).toHaveLength(1);
    const product = result.candidates[0];
    expect(product["@type"]).toBe("Product");
    expect(product["sku"]).toBe("MOL-001");
    const offer = product["offers"] as Record<string, unknown>;
    expect(offer["sku"]).toBeUndefined();
    expect(offer["availability"]).toBe("https://schema.org/InStock");
    expect(validateSchema(product).valid).toBe(true);
  });
});

describe("repairToGoal — LLM repair path", () => {
  it("feeds validation errors back to the LLM and re-gates until valid", async () => {
    // A Product missing its required `offers` — the deterministic fixer cannot invent
    // an offer, so only the LLM repair round can satisfy the gate.
    const broken: Record<string, unknown>[] = [
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Matter Bifold",
      },
    ];

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
      enhancementNotes: ["Filled in the missing offer from page context."],
    }));

    const onAttempt = vi.fn();
    const result = await repairToGoal({
      ...goalInput,
      url: "https://pioneercarry.com/products/matter-bifold",
      candidates: broken,
      refineFn,
      onAttempt,
    });

    expect(refineFn).toHaveBeenCalledTimes(1);
    expect(result.satisfied).toBe(true);
    expect(result.attempts).toBe(1);
    expect(onAttempt).toHaveBeenCalledWith(1, expect.stringContaining("repairing"));
    expect(result.enhancementNotes).toContain(
      "Filled in the missing offer from page context."
    );
  });

  it("stops without thrashing when the LLM cannot improve the candidate", async () => {
    const broken: Record<string, unknown>[] = [
      { "@context": "https://schema.org", "@type": "Product", name: "Flyfold" },
    ];
    // A refine fn that returns the same broken schema every time — no improvement.
    const refineFn = vi.fn<RefineFn>(async (schema) => ({
      refined: schema as Record<string, unknown>,
      enhancementNotes: [],
    }));

    const result = await repairToGoal({
      ...goalInput,
      candidates: broken,
      refineFn,
      maxAttempts: 3,
    });

    expect(result.satisfied).toBe(false);
    // One round runs, sees no improvement, and breaks — it must NOT burn all 3 attempts.
    expect(refineFn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
  });

  it("respects maxAttempts: 0 (deterministic only, never calls the LLM)", async () => {
    const refineFn = vi.fn<RefineFn>();
    const result = await repairToGoal({
      ...goalInput,
      url: "https://pioneercarry.com/products/the-flyfold",
      candidates: [
        { "@context": "https://schema.org", "@type": "Product", name: "Flyfold" },
      ],
      refineFn,
      maxAttempts: 0,
    });
    expect(refineFn).not.toHaveBeenCalled();
    expect(result.satisfied).toBe(false);
  });

  it("guards against a repair that morphs the @type", async () => {
    const broken: Record<string, unknown>[] = [
      { "@context": "https://schema.org", "@type": "Product", name: "X" },
    ];
    // The LLM "fixes" the page by returning a totally different type — must be rejected.
    const refineFn = vi.fn<RefineFn>(async () => ({
      refined: { "@context": "https://schema.org", "@type": "Organization", name: "X" },
      enhancementNotes: [],
    }));
    const result = await repairToGoal({
      ...goalInput,
      candidates: broken,
      refineFn,
    });
    expect(result.satisfied).toBe(false);
    expect(result.candidates[0]["@type"]).toBe("Product"); // unchanged
  });
});

describe("dedupeCandidatesByType (dev-store duplicate-Product finding)", () => {
  it("keeps exactly one candidate per primary type, preferring valid then newest", () => {
    const oldProduct = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Old injected Product",
      offers: { "@type": "Offer", price: 10, priceCurrency: "USD", availability: "https://schema.org/InStock" },
    };
    const newProduct = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Newly generated Product",
      offers: { "@type": "Offer", price: 12, priceCurrency: "USD", availability: "https://schema.org/InStock" },
    };
    const invalidOrg = { "@context": "https://schema.org", "@type": "Organization", name: "x" }; // url missing
    const validOrg = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "x",
      url: "https://shop.test",
    };
    const breadcrumb = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://shop.test" },
        { "@type": "ListItem", position: 2, name: "P", item: "https://shop.test/p" },
      ],
    };

    const out = dedupeCandidatesByType([
      oldProduct,
      invalidOrg,
      newProduct,
      validOrg,
      breadcrumb,
    ] as Record<string, unknown>[]);

    expect(out).toHaveLength(3);
    const names = out.map((c) => (c as { name?: string }).name);
    // Both Products are equally valid → the NEWEST (generated) wins.
    expect(names).toContain("Newly generated Product");
    expect(names).not.toContain("Old injected Product");
    // The valid Organization beats the invalid one.
    expect(out.some((c) => (c as { url?: string }).url === "https://shop.test")).toBe(true);
    expect(out.some((c) => (c as { "@type"?: string })["@type"] === "BreadcrumbList")).toBe(true);
  });
});
