/**
 * Symmetric encryption for secrets at rest (issue #32).
 *
 * The Shopify `app_secret` and `storefront_password` are live store-admin
 * secrets. Storing them as plaintext means a DB backup leak, a dashboard table
 * view, or a service-role-key compromise hands them over directly. We encrypt
 * them at the application layer with AES-256-GCM so the database only ever holds
 * ciphertext and the key lives in the app's environment, never in a SQL
 * statement (unlike pgcrypto) and never in the DB.
 *
 * Ciphertext format (string, safe for a TEXT column):
 *   v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * Backward / dev compatibility: when CREDENTIAL_ENCRYPTION_KEY is unset,
 * encryptSecret is a passthrough (returns plaintext unchanged) so local dev and
 * unit tests behave exactly as before. decryptSecret treats any value WITHOUT
 * the `v1:` prefix as legacy bare plaintext and returns it as-is. This makes the
 * migration zero-downtime: existing plaintext rows keep resolving, and they get
 * re-encrypted the next time they're upserted (once the key is configured).
 *
 * Production MUST set CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64 or hex). When
 * it is absent we log a one-time warning on the first store of a secret so a
 * misconfigured prod deploy is loud rather than silently plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const PREFIX = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

let warnedMissingKey = false;

/**
 * Resolve the 32-byte key from CREDENTIAL_ENCRYPTION_KEY, accepting base64 or
 * hex. Returns null when unset. Throws on a present-but-malformed key — a
 * wrong-length key in production is a configuration error we must not paper over.
 */
function resolveKey(): Buffer | null {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();

  // Try base64 first, then hex; accept whichever yields exactly 32 bytes.
  const candidates: Buffer[] = [];
  try {
    candidates.push(Buffer.from(trimmed, "base64"));
  } catch {
    /* ignore */
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, "hex"));
  }
  const key = candidates.find((b) => b.length === KEY_BYTES);
  if (!key) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes ` +
        `(base64 or hex); got ${candidates[0]?.length ?? 0}`
    );
  }
  return key;
}

/** True when a usable encryption key is configured. */
export function encryptionEnabled(): boolean {
  return resolveKey() !== null;
}

/**
 * Encrypt a secret for storage. Null/undefined pass through as null (a cleared
 * storefront password stays null). When no key is configured, returns the
 * plaintext unchanged (dev/test) after warning once.
 */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const key = resolveKey();
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      // Loud, but never logs the secret itself.
      console.warn(
        "[crypto/secrets] CREDENTIAL_ENCRYPTION_KEY is not set — storing secret " +
          "as plaintext. Set it before any production deployment."
      );
    }
    return plaintext;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored secret. Null passes through. A value without the `v1:` prefix
 * is treated as legacy bare plaintext and returned as-is (so pre-#32 rows still
 * resolve). A `v1:` value requires the key — a missing/wrong key throws rather
 * than returning garbage.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!stored.startsWith(`${PREFIX}:`)) {
    // Legacy plaintext (pre-encryption row) or dev passthrough.
    return stored;
  }
  const key = resolveKey();
  if (!key) {
    throw new Error(
      "Encountered an encrypted secret (v1:) but CREDENTIAL_ENCRYPTION_KEY is " +
        "not set — cannot decrypt."
    );
  }
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted secret: expected v1:iv:tag:ciphertext");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
