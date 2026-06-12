import { describe, it, expect, vi, beforeEach } from "vitest";

function chain(value: unknown) {
  const self = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(value);
          return () => self();
        },
      }
    );
  return self();
}

function mockAuthed(opts: { user?: { id: string } | null; site?: unknown }) {
  const { user = { id: "user-1" }, site = { id: "site-1" } } = opts;
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: (table: string) =>
      table === "sites" ? chain({ data: site }) : chain({ data: null }),
  };
}

vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));

// Mock ONLY the LLM proposer + persistence; applyOverrides stays real, and
// validateSchema (lib/validation — THE gate) runs for real on the result.
const overridesMock = vi.hoisted(() => ({
  proposeOverrideEdits: vi.fn(),
  saveOverride: vi.fn(),
}));
vi.mock("@/lib/agent/overrides", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/overrides")>();
  return { ...actual, ...overridesMock };
});

import { createSupabaseServerClient } from "@/lib/supabase-server";
import { POST } from "../route";

const mockAuthedClient = vi.mocked(createSupabaseServerClient);

// Valid Product (validateSchema: no errors — Product only requires name).
const PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Tow Strap",
  description: "LLM-written description",
  image: "https://shop.example/strap.jpg",
  sku: "TS-100",
  offers: {
    "@type": "Offer",
    price: "19.99",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: "https://shop.example/products/strap",
  },
};

const BODY = {
  siteId: "site-1",
  url: "https://shop.example/products/strap",
  schemaType: "Product",
  currentJsonld: PRODUCT,
  message: "The brand is Garner & Tow",
};

function req(body: unknown) {
  return new Request("http://localhost/api/agent/overrides/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
  overridesMock.proposeOverrideEdits.mockResolvedValue([
    { fieldPath: "brand.name", value: "Garner & Tow", reason: "Merchant stated the brand." },
  ]);
  overridesMock.saveOverride.mockImplementation(async (o: Record<string, unknown>) => ({
    id: "ov-1",
    ...o,
    createdAt: "2026-06-09T00:00:00Z",
    updatedAt: "2026-06-09T00:00:00Z",
  }));
});

describe("POST /api/agent/overrides/chat", () => {
  it("401 when unauthenticated", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ user: null }) as never);
    const res = await POST(req(BODY));
    expect(res.status).toBe(401);
    expect(overridesMock.proposeOverrideEdits).not.toHaveBeenCalled();
  });

  it("400 on a malformed body", async () => {
    const res = await POST(req({ siteId: "site-1" }));
    expect(res.status).toBe(400);
    expect(overridesMock.proposeOverrideEdits).not.toHaveBeenCalled();
  });

  it("400 on a non-JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/agent/overrides/chat", {
        method: "POST",
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("404 when the site is not owned by the user", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ site: null }) as never);
    const res = await POST(req(BODY));
    expect(res.status).toBe(404);
    expect(overridesMock.proposeOverrideEdits).not.toHaveBeenCalled();
  });

  it("400 when currentJsonld has no node of the requested @type", async () => {
    const res = await POST(req({ ...BODY, schemaType: "Recipe" }));
    expect(res.status).toBe(400);
    expect(overridesMock.proposeOverrideEdits).not.toHaveBeenCalled();
  });

  it("applies valid edits, persists sticky overrides, and returns the updated JSON-LD", async () => {
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.updatedJsonld.brand.name).toBe("Garner & Tow");
    expect(data.edits).toHaveLength(1);
    expect(data.validation.errors).toHaveLength(0);
    expect(overridesMock.saveOverride).toHaveBeenCalledTimes(1);
    expect(overridesMock.saveOverride).toHaveBeenCalledWith({
      siteId: "site-1",
      url: BODY.url,
      schemaType: "Product",
      fieldPath: "brand.name",
      value: "Garner & Tow",
      source: "chat",
    });
  });

  it("400 + no persistence when an edit set makes the schema invalid", async () => {
    // Removing the required `name` (setting it empty) is a validation error.
    overridesMock.proposeOverrideEdits.mockResolvedValue([
      { fieldPath: "name", value: "", reason: "merchant asked" },
    ]);
    const res = await POST(req(BODY));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid");
    expect(data.validation.valid).toBe(false);
    expect(overridesMock.saveOverride).not.toHaveBeenCalled();
  });

  it("400 + no persistence when an edit path conflicts with the document shape", async () => {
    overridesMock.proposeOverrideEdits.mockResolvedValue([
      { fieldPath: "offers.5.price", value: "10.00", reason: "bad path" },
    ]);
    const res = await POST(req(BODY));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.conflicts).toHaveLength(1);
    expect(overridesMock.saveOverride).not.toHaveBeenCalled();
  });

  it("400 when the LLM maps the instruction to zero edits", async () => {
    overridesMock.proposeOverrideEdits.mockResolvedValue([]);
    const res = await POST(req(BODY));
    expect(res.status).toBe(400);
    expect(overridesMock.saveOverride).not.toHaveBeenCalled();
  });

  it("502 when the LLM call fails", async () => {
    overridesMock.proposeOverrideEdits.mockRejectedValue(new Error("inference down"));
    const res = await POST(req(BODY));
    expect(res.status).toBe(502);
    expect(overridesMock.saveOverride).not.toHaveBeenCalled();
  });

  it("targets the right member of a @graph document", async () => {
    const graphDoc = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Shop", url: "https://shop.example" },
        PRODUCT,
      ],
    };
    overridesMock.proposeOverrideEdits.mockResolvedValue([
      {
        // "0" on an offers-as-object resolves to the object itself.
        fieldPath: "offers.0.availability",
        value: "https://schema.org/PreOrder",
        reason: "Merchant said preorder.",
      },
    ]);
    const res = await POST(req({ ...BODY, currentJsonld: graphDoc }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updatedJsonld["@graph"][1].offers.availability).toBe(
      "https://schema.org/PreOrder"
    );
  });
});
