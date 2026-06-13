/**
 * Unit tests for secret-at-rest encryption (issue #32). No DB, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  encryptionEnabled,
} from "../secrets";

const saved = { ...process.env };
// A valid 32-byte key, base64-encoded.
const KEY_B64 = randomBytes(32).toString("base64");

afterEach(() => {
  process.env = { ...saved };
});

describe("with CREDENTIAL_ENCRYPTION_KEY set", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_B64;
  });

  it("reports encryption enabled", () => {
    expect(encryptionEnabled()).toBe(true);
  });

  it("round-trips a secret", () => {
    const ct = encryptSecret("shpss_live_secret");
    expect(ct).not.toBeNull();
    expect(ct).toMatch(/^v1:/);
    expect(ct).not.toContain("shpss_live_secret");
    expect(decryptSecret(ct)).toBe("shpss_live_secret");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("passes null/undefined through as null", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(decryptSecret(null)).toBeNull();
  });

  it("still reads a legacy bare-plaintext value", () => {
    expect(decryptSecret("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("rejects a tampered ciphertext (auth tag)", () => {
    const ct = encryptSecret("secret")!;
    const parts = ct.split(":");
    // Flip the last char of the ciphertext segment.
    const last = parts[3];
    parts[3] = last.slice(0, -1) + (last.endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("accepts a hex-encoded key too", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
  });

  it("throws on a wrong-length key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "too-short";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});

describe("without CREDENTIAL_ENCRYPTION_KEY (dev/test passthrough)", () => {
  beforeEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  });

  it("reports encryption disabled", () => {
    expect(encryptionEnabled()).toBe(false);
  });

  it("stores plaintext unchanged and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(encryptSecret("plain")).toBe("plain");
    expect(decryptSecret("plain")).toBe("plain");
    warn.mockRestore();
  });

  it("throws if asked to decrypt a v1: value with no key", () => {
    expect(() => decryptSecret("v1:a:b:c")).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });
});
