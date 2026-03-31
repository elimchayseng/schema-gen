import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock processPage
vi.mock("@/lib/crawl/process-page", () => ({
  processPage: vi.fn(),
}));

// Mock Supabase
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();
const mockEq = vi.fn();
const mockIn = vi.fn();
const mockIs = vi.fn();
const mockNot = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockSingle = vi.fn();

function createChain(finalValue: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () =>
    new Proxy(
      {},
      {
        get(_, prop: string) {
          if (prop === "then") {
            // Make it thenable so await works
            return (resolve: (v: unknown) => void) => resolve(finalValue);
          }
          return (..._args: unknown[]) => self();
        },
      }
    );
  return self();
}

// Track calls for assertions
let supabaseCalls: { method: string; args: unknown[] }[] = [];

function createMockSupabase(options: {
  crawl?: Record<string, unknown> | null;
  pagesToFix?: Record<string, unknown>[];
  remainingPages?: Record<string, unknown>[];
  attemptedCount?: number;
  remainingCount?: number;
  user?: { id: string } | null;
}) {
  const {
    crawl = { id: "crawl-1", status: "completed", sites: { user_id: "user-1" } },
    pagesToFix = [],
    remainingPages = [],
    attemptedCount = 0,
    remainingCount = 0,
    user = { id: "user-1" },
  } = options;

  supabaseCalls = [];

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn((table: string) => {
      const makeChain = (resolveValue: unknown) => {
        const chainObj = {
          select: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          upsert: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          not: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn(function (this: typeof chainObj) {
            return Promise.resolve(resolveValue);
          }),
          single: vi.fn(() => Promise.resolve(resolveValue)),
          then: (resolve: (v: unknown) => void) => resolve(resolveValue),
        };
        // Make select return the chain AND be thenable for count queries
        chainObj.select = vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            // Count query - return chain that resolves to count
            return chainObj;
          }
          return chainObj;
        });
        return chainObj;
      };

      if (table === "crawl_jobs") {
        return makeChain({ data: crawl, error: null });
      }
      if (table === "page_schemas") {
        // Return different results based on call order
        const call = supabaseCalls.filter((c) => c.method === "page_schemas").length;
        supabaseCalls.push({ method: "page_schemas", args: [table] });

        if (call === 0) {
          // First call: fetch pages to fix
          return makeChain({ data: pagesToFix });
        }
        // Subsequent calls: various counts and updates
        return makeChain({
          data: remainingPages,
          count: call <= 2 ? attemptedCount : remainingCount,
        });
      }
      if (table === "schemas") {
        return makeChain({ data: null, error: null });
      }
      return makeChain({ data: null });
    }),
  };
}

vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

import { processPage } from "@/lib/crawl/process-page";
import { createSupabaseServerClient } from "@/lib/supabase-server";

const mockProcessPage = vi.mocked(processPage);
const mockCreateSupabase = vi.mocked(createSupabaseServerClient);

describe("fix-all route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseCalls = [];
  });

  describe("mode dispatch", () => {
    it("uses optimize mode for no_schema pages", async () => {
      const supabase = createMockSupabase({
        pagesToFix: [{ id: "p1", url: "https://example.com/about", status: "no_schema" }],
        remainingPages: [],
        attemptedCount: 1,
        remainingCount: 0,
      });
      mockCreateSupabase.mockResolvedValue(supabase as never);

      mockProcessPage.mockResolvedValue({
        url: "https://example.com/about",
        status: "valid",
        originalSchemas: null,
        fixedSchemas: [{ "@type": "WebPage" }],
        validationResults: {
          errorCount: 0,
          warningCount: 0,
          schemas: [],
        },
      });

      // Import and call the route handler
      const { POST } = await import("../route");
      const request = new Request("http://localhost/api/crawl/crawl-1/fix-all", {
        method: "POST",
      });
      const response = await POST(request, { params: Promise.resolve({ id: "crawl-1" }) });
      // Drain the SSE stream so the async processing completes
      if (response.body) {
        const reader = response.body.getReader();
        while (!(await reader.read()).done) {}
      }

      expect(mockProcessPage).toHaveBeenCalledWith(
        "https://example.com/about",
        "optimize",
        expect.any(Function)
      );
    });

    it("uses scan mode for errors pages", async () => {
      const supabase = createMockSupabase({
        pagesToFix: [{ id: "p1", url: "https://example.com/product", status: "errors" }],
        remainingPages: [],
        attemptedCount: 1,
        remainingCount: 0,
      });
      mockCreateSupabase.mockResolvedValue(supabase as never);

      mockProcessPage.mockResolvedValue({
        url: "https://example.com/product",
        status: "warnings",
        originalSchemas: [{ "@type": "Product" }],
        fixedSchemas: [{ "@type": "Product", name: "Fixed" }],
        validationResults: {
          errorCount: 0,
          warningCount: 1,
          schemas: [],
        },
      });

      const { POST } = await import("../route");
      const request = new Request("http://localhost/api/crawl/crawl-1/fix-all", {
        method: "POST",
      });
      const response = await POST(request, { params: Promise.resolve({ id: "crawl-1" }) });
      if (response.body) {
        const reader = response.body.getReader();
        while (!(await reader.read()).done) {}
      }

      expect(mockProcessPage).toHaveBeenCalledWith(
        "https://example.com/product",
        "scan",
        expect.any(Function)
      );
    });

    it("uses scan mode for warnings pages", async () => {
      const supabase = createMockSupabase({
        pagesToFix: [{ id: "p1", url: "https://example.com/blog", status: "warnings" }],
        remainingPages: [],
        attemptedCount: 1,
        remainingCount: 0,
      });
      mockCreateSupabase.mockResolvedValue(supabase as never);

      mockProcessPage.mockResolvedValue({
        url: "https://example.com/blog",
        status: "warnings",
        originalSchemas: [{ "@type": "Article" }],
        fixedSchemas: [{ "@type": "Article", name: "Blog" }],
        validationResults: {
          errorCount: 0,
          warningCount: 1,
          schemas: [],
        },
      });

      const { POST } = await import("../route");
      const request = new Request("http://localhost/api/crawl/crawl-1/fix-all", {
        method: "POST",
      });
      const response = await POST(request, { params: Promise.resolve({ id: "crawl-1" }) });
      if (response.body) {
        const reader = response.body.getReader();
        while (!(await reader.read()).done) {}
      }

      expect(mockProcessPage).toHaveBeenCalledWith(
        "https://example.com/blog",
        "scan",
        expect.any(Function)
      );
    });
  });

  describe("idempotency", () => {
    it("returns fixComplete when no unattempted pages remain", async () => {
      const supabase = createMockSupabase({
        pagesToFix: [], // No pages with fix_attempted_at IS NULL
        attemptedCount: 5,
        remainingCount: 0,
      });
      mockCreateSupabase.mockResolvedValue(supabase as never);

      const { POST } = await import("../route");
      const request = new Request("http://localhost/api/crawl/crawl-1/fix-all", {
        method: "POST",
      });
      const response = await POST(request, { params: Promise.resolve({ id: "crawl-1" }) });
      const data = await response.json();

      expect(data.fixComplete).toBe(true);
      expect(data.processed).toBe(0);
      expect(mockProcessPage).not.toHaveBeenCalled();
    });
  });
});
