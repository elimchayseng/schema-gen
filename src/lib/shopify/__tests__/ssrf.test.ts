import { describe, it, expect } from "vitest";
import {
  assertShopifyHost,
  assertShopifyUrl,
  isValidShopifyHost,
} from "../ssrf";

describe("isValidShopifyHost", () => {
  it("accepts a normal shop host", () => {
    expect(isValidShopifyHost("my-dev-store.myshopify.com")).toBe(true);
    expect(isValidShopifyHost("store123.myshopify.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidShopifyHost("My-Store.MyShopify.Com")).toBe(true);
  });

  it("rejects non-shopify hosts", () => {
    expect(isValidShopifyHost("evil.com")).toBe(false);
    expect(isValidShopifyHost("example.org")).toBe(false);
  });

  it("rejects look-alike hosts that only contain myshopify.com", () => {
    // suffix attack
    expect(isValidShopifyHost("my-store.myshopify.com.evil.com")).toBe(false);
    // myshopify.com as a subdomain of an attacker domain
    expect(isValidShopifyHost("myshopify.com.evil.com")).toBe(false);
    // extra label before .myshopify.com (store handles have no dots)
    expect(isValidShopifyHost("a.b.myshopify.com")).toBe(false);
    // trailing dot
    expect(isValidShopifyHost("my-store.myshopify.com.")).toBe(false);
  });

  it("rejects malformed handles with leading/trailing hyphens", () => {
    expect(isValidShopifyHost("store-.myshopify.com")).toBe(false);
    expect(isValidShopifyHost("-store.myshopify.com")).toBe(false);
    // interior hyphens are fine
    expect(isValidShopifyHost("my-cool-store.myshopify.com")).toBe(true);
  });

  it("rejects an empty / malformed host", () => {
    expect(isValidShopifyHost("")).toBe(false);
    expect(isValidShopifyHost(".myshopify.com")).toBe(false);
  });
});

describe("assertShopifyHost", () => {
  it("does not throw for a valid host", () => {
    expect(() => assertShopifyHost("my-store.myshopify.com")).not.toThrow();
  });

  it("throws for an invalid host", () => {
    expect(() => assertShopifyHost("evil.com")).toThrow(/Refusing to contact/);
  });
});

describe("assertShopifyUrl", () => {
  it("accepts an https admin API url on a valid shop host", () => {
    expect(() =>
      assertShopifyUrl(
        "https://my-store.myshopify.com/admin/api/2025-01/themes.json"
      )
    ).not.toThrow();
  });

  it("rejects http (must be https)", () => {
    expect(() =>
      assertShopifyUrl("http://my-store.myshopify.com/admin/api/2025-01/themes.json")
    ).toThrow(/https/);
  });

  it("rejects a url pointing at a non-shopify host", () => {
    expect(() => assertShopifyUrl("https://evil.com/admin/api/x")).toThrow(
      /Refusing to contact/
    );
  });

  it("rejects a malformed url", () => {
    expect(() => assertShopifyUrl("not a url")).toThrow(/Invalid Shopify URL/);
  });
});
