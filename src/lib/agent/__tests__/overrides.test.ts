import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Supabase admin mock (audit.test.ts idiom) ───────────────────────────────

const adminMock = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase", () => adminMock);

import {
  applyOverrides,
  loadOverrides,
  saveOverride,
  deleteOverride,
  getOverride,
  proposeOverrideEdits,
  type OverrideInput,
} from "../overrides";

// ─── applyOverrides (pure) ───────────────────────────────────────────────────

function product(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Tow Strap",
    description: "LLM-written description",
    offers: [
      {
        "@type": "Offer",
        price: "19.99",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
      },
    ],
  };
}

const ov = (
  fieldPath: string,
  value: unknown,
  schemaType = "Product"
): OverrideInput => ({ schemaType, fieldPath, value });

describe("applyOverrides", () => {
  it("sets a top-level field on a single object", () => {
    const { result, applied, conflicts } = applyOverrides(product(), [
      ov("description", "Merchant-approved description"),
    ]);
    expect((result as Record<string, unknown>).description).toBe(
      "Merchant-approved description"
    );
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
  });

  it("sets a nested path, creating missing intermediate objects", () => {
    // No `brand` on the generated schema — the override still lands.
    const { result, applied } = applyOverrides(product(), [
      ov("brand.name", "Garner & Tow"),
    ]);
    expect(
      ((result as Record<string, unknown>).brand as Record<string, unknown>).name
    ).toBe("Garner & Tow");
    expect(applied).toHaveLength(1);
  });

  it("sets an array element field via a numeric segment", () => {
    const { result, applied } = applyOverrides(product(), [
      ov("offers.0.availability", "https://schema.org/PreOrder"),
    ]);
    const offers = (result as Record<string, unknown>).offers as Record<
      string,
      unknown
    >[];
    expect(offers[0].availability).toBe("https://schema.org/PreOrder");
    expect(applied).toHaveLength(1);
  });

  it('treats a "0" segment on a plain object as the object itself (offers-as-object)', () => {
    const doc = product();
    doc.offers = {
      "@type": "Offer",
      price: "19.99",
      availability: "https://schema.org/InStock",
    };
    const { result, applied, conflicts } = applyOverrides(doc, [
      ov("offers.0.availability", "https://schema.org/PreOrder"),
    ]);
    expect(
      ((result as Record<string, unknown>).offers as Record<string, unknown>)
        .availability
    ).toBe("https://schema.org/PreOrder");
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
  });

  it("targets the matching member of a top-level array by @type", () => {
    const doc = [
      { "@context": "https://schema.org", "@type": "Organization", name: "Acme" },
      product(),
    ];
    const { result, applied } = applyOverrides(doc, [
      ov("name", "Acme Corp", "Organization"),
      ov("name", "Heavy Tow Strap", "Product"),
    ]);
    const arr = result as Record<string, unknown>[];
    expect(arr[0].name).toBe("Acme Corp");
    expect(arr[1].name).toBe("Heavy Tow Strap");
    expect(applied).toHaveLength(2);
  });

  it("targets a member inside @graph by @type", () => {
    const doc = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        { "@type": "Product", name: "Strap", offers: [{ "@type": "Offer" }] },
      ],
    };
    const { result, applied } = applyOverrides(doc, [
      ov("offers.0.price", "29.99"),
    ]);
    const graph = (result as Record<string, unknown>)["@graph"] as Record<
      string,
      unknown
    >[];
    expect(
      (graph[1].offers as Record<string, unknown>[])[0].price
    ).toBe("29.99");
    expect(applied).toHaveLength(1);
  });

  it("matches when @type is an array", () => {
    const doc = {
      "@context": "https://schema.org",
      "@type": ["Product", "IndividualProduct"],
      name: "Strap",
    };
    const { applied } = applyOverrides(doc, [ov("name", "New Name")]);
    expect(applied).toHaveLength(1);
  });

  it("records a conflict (and leaves the doc unchanged) when no node matches the @type", () => {
    const input = product();
    const { result, applied, conflicts } = applyOverrides(input, [
      ov("name", "X", "Recipe"),
    ]);
    expect(applied).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toContain('no node with @type "Recipe"');
    expect(result).toEqual(input);
  });

  it("records a conflict for an out-of-bounds array index", () => {
    const { applied, conflicts } = applyOverrides(product(), [
      ov("offers.5.price", "10.00"),
    ]);
    expect(applied).toHaveLength(0);
    expect(conflicts[0].reason).toContain("out of bounds");
  });

  it("records a conflict when traversing through a primitive", () => {
    const { conflicts } = applyOverrides(product(), [
      ov("name.first", "nope"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toContain("primitive");
  });

  it("records a conflict when an index path needs a missing array", () => {
    const { conflicts } = applyOverrides(product(), [
      ov("review.2.author", "Jane"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toContain("missing array");
  });

  it("records a conflict for a final numeric segment on a non-array", () => {
    const doc = product();
    doc.offers = { "@type": "Offer" };
    const { conflicts } = applyOverrides(doc, [ov("offers.1", { price: "1" })]);
    expect(conflicts).toHaveLength(1);
  });

  it("records a conflict for an empty field path", () => {
    const { conflicts } = applyOverrides(product(), [ov("", "x")]);
    expect(conflicts[0].reason).toBe("empty field path");
  });

  it("never mutates the input document or the override values", () => {
    const input = product();
    const snapshot = structuredClone(input);
    const objectValue = { "@type": "Brand", name: "Garner & Tow" };
    const { result } = applyOverrides(input, [ov("brand", objectValue)]);
    expect(input).toEqual(snapshot);
    // Mutating the applied value in the result must not reach the caller's object.
    ((result as Record<string, unknown>).brand as Record<string, unknown>).name =
      "tampered";
    expect(objectValue.name).toBe("Garner & Tow");
  });

  it("is idempotent — applying the same overrides twice yields the same result", () => {
    const overrides = [
      ov("description", "Sticky description"),
      ov("brand.name", "Garner & Tow"),
      ov("offers.0.availability", "https://schema.org/PreOrder"),
    ];
    const once = applyOverrides(product(), overrides);
    const twice = applyOverrides(once.result, overrides);
    expect(twice.result).toEqual(once.result);
    expect(twice.applied).toHaveLength(3);
    expect(twice.conflicts).toHaveLength(0);
  });

  it("applies good overrides while conflicting ones are skipped (mixed set)", () => {
    const { result, applied, conflicts } = applyOverrides(product(), [
      ov("description", "Good"),
      ov("offers.9.price", "1.00"),
      ov("sku", "TS-100"),
    ]);
    expect(applied.map((a) => a.fieldPath)).toEqual(["description", "sku"]);
    expect(conflicts).toHaveLength(1);
    expect((result as Record<string, unknown>).sku).toBe("TS-100");
  });

  it("supports object and array replacement values", () => {
    const { result, applied } = applyOverrides(product(), [
      ov("offers", [{ "@type": "Offer", price: "5.00", priceCurrency: "USD" }]),
    ]);
    const offers = (result as Record<string, unknown>).offers as Record<
      string,
      unknown
    >[];
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe("5.00");
    expect(applied).toHaveLength(1);
  });
});

// ─── Persistence ─────────────────────────────────────────────────────────────

const ROW = {
  id: "ov-1",
  site_id: "site-1",
  url: "https://shop.example/products/strap",
  schema_type: "Product",
  field_path: "brand.name",
  value: "Garner & Tow",
  source: "chat" as const,
  created_at: "2026-06-09T00:00:00Z",
  updated_at: "2026-06-09T00:00:00Z",
};

describe("override persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadOverrides maps snake_case rows to MerchantOverride", async () => {
    const order = vi.fn().mockResolvedValue({ data: [ROW], error: null });
    const eq2 = vi.fn().mockReturnValue({ order });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    adminMock.createAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ select }),
    } as never);

    const result = await loadOverrides("site-1", ROW.url);
    expect(result).toEqual([
      {
        id: "ov-1",
        siteId: "site-1",
        url: ROW.url,
        schemaType: "Product",
        fieldPath: "brand.name",
        value: "Garner & Tow",
        source: "chat",
        createdAt: ROW.created_at,
        updatedAt: ROW.updated_at,
      },
    ]);
    expect(eq1).toHaveBeenCalledWith("site_id", "site-1");
    expect(eq2).toHaveBeenCalledWith("url", ROW.url);
  });

  it("loadOverrides throws on a Supabase error", async () => {
    const order = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "boom" } });
    const eq2 = vi.fn().mockReturnValue({ order });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    adminMock.createAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: eq1 }) }),
    } as never);
    await expect(loadOverrides("site-1", ROW.url)).rejects.toThrow("boom");
  });

  it("saveOverride upserts on the unique key and returns the saved row", async () => {
    const single = vi.fn().mockResolvedValue({ data: ROW, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const upsert = vi.fn().mockReturnValue({ select });
    adminMock.createAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ upsert }),
    } as never);

    const saved = await saveOverride({
      siteId: "site-1",
      url: ROW.url,
      schemaType: "Product",
      fieldPath: "brand.name",
      value: "Garner & Tow",
      source: "chat",
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        site_id: "site-1",
        url: ROW.url,
        schema_type: "Product",
        field_path: "brand.name",
        value: "Garner & Tow",
        source: "chat",
      }),
      { onConflict: "site_id,url,schema_type,field_path" }
    );
    expect(saved.id).toBe("ov-1");
    expect(saved.fieldPath).toBe("brand.name");
  });

  it("deleteOverride deletes scoped to site_id", async () => {
    const eq2 = vi.fn().mockResolvedValue({ error: null });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const del = vi.fn().mockReturnValue({ eq: eq1 });
    adminMock.createAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: del }),
    } as never);

    await deleteOverride("ov-1", "site-1");
    expect(eq1).toHaveBeenCalledWith("id", "ov-1");
    expect(eq2).toHaveBeenCalledWith("site_id", "site-1");
  });

  it("getOverride returns null when the row does not exist", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    adminMock.createAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }),
    } as never);
    expect(await getOverride("missing")).toBeNull();
  });
});

// ─── proposeOverrideEdits (LLM proposer — fetch mocked, never live) ──────────

function llmResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

describe("proposeOverrideEdits", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HEROKU_INFERENCE_URL", "https://inference.test");
    vi.stubEnv("HEROKU_INFERENCE_KEY", "test-key");
    vi.stubEnv("HEROKU_INFERENCE_MODEL", "test-model");
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const args = {
    currentJsonld: product(),
    schemaType: "Product",
    url: "https://shop.example/products/strap",
    message: "The brand is Garner & Tow",
  };

  it("parses a strict-JSON edits response", async () => {
    fetchSpy.mockResolvedValue(
      llmResponse(
        JSON.stringify({
          edits: [
            { fieldPath: "brand.name", value: "Garner & Tow", reason: "Merchant stated the brand." },
          ],
        })
      )
    );
    const edits = await proposeOverrideEdits(args);
    expect(edits).toEqual([
      { fieldPath: "brand.name", value: "Garner & Tow", reason: "Merchant stated the brand." },
    ]);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
  });

  it("strips markdown code fences", async () => {
    fetchSpy.mockResolvedValue(
      llmResponse(
        '```json\n{"edits":[{"fieldPath":"description","value":"Better copy","reason":"r"}]}\n```'
      )
    );
    const edits = await proposeOverrideEdits(args);
    expect(edits[0].fieldPath).toBe("description");
  });

  it("throws when the API responds non-ok", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream down",
    } as unknown as Response);
    await expect(proposeOverrideEdits(args)).rejects.toThrow("500");
  });

  it("throws on a non-JSON response", async () => {
    fetchSpy.mockResolvedValue(llmResponse("sure, I changed the brand for you!"));
    await expect(proposeOverrideEdits(args)).rejects.toThrow("not valid JSON");
  });

  it("throws on a shape mismatch", async () => {
    fetchSpy.mockResolvedValue(llmResponse('{"edits":[{"value":"x"}]}'));
    await expect(proposeOverrideEdits(args)).rejects.toThrow("expected shape");
  });

  it("throws when inference env vars are missing", async () => {
    vi.stubEnv("HEROKU_INFERENCE_URL", "");
    await expect(proposeOverrideEdits(args)).rejects.toThrow(
      "Missing Heroku Inference environment variables"
    );
  });
});
