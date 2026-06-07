import { describe, it, expect, vi, afterEach } from "vitest";
import { scrubSensitive, shopifyLog } from "../logger";

describe("scrubSensitive", () => {
  it("redacts sensitive keys case-insensitively", () => {
    const out = scrubSensitive({
      token: "secret-token",
      Authorization: "Bearer x",
      "X-Shopify-Access-Token": "shpat_xxx",
      access_token: "a",
      path: "/themes.json",
      status: 429,
    });
    expect(out.token).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out["X-Shopify-Access-Token"]).toBe("[REDACTED]");
    expect(out.access_token).toBe("[REDACTED]");
    // non-sensitive fields pass through untouched
    expect(out.path).toBe("/themes.json");
    expect(out.status).toBe(429);
  });

  it("does not mutate the input object", () => {
    const input = { token: "secret" };
    scrubSensitive(input);
    expect(input.token).toBe("secret");
  });

  it("redacts tokens nested inside objects and arrays", () => {
    const out = scrubSensitive({
      headers: { Authorization: "Bearer abc", Accept: "application/json" },
      items: [{ access_token: "shpat_1" }, { ok: true }],
    });
    const headers = out.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe("[REDACTED]");
    expect(headers.Accept).toBe("application/json");
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0].access_token).toBe("[REDACTED]");
    expect(items[1].ok).toBe(true);
  });
});

describe("shopifyLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits component-tagged JSON and never leaks a token", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    shopifyLog("warn", "backing off", { token: "shpat_secret", attempt: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const logged = spy.mock.calls[0][0] as string;
    expect(logged).not.toContain("shpat_secret");
    const parsed = JSON.parse(logged);
    expect(parsed.component).toBe("shopify");
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toBe("backing off");
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.attempt).toBe(1);
  });

  it("routes error level to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    shopifyLog("error", "boom");
    expect(spy).toHaveBeenCalledOnce();
  });
});
