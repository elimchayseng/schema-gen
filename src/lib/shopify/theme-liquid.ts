/**
 * Idempotent marker-block management for theme.liquid (agent Phase 1).
 *
 * SchemaGen owns exactly one line in theme.liquid: a delimited include of the
 * managed snippet. All schema logic lives in the snippet; theme.liquid stays a
 * one-line diff forever.
 *
 *   <!-- SCHEMAGEN:START -->{% render 'schemagen-jsonld' %}<!-- SCHEMAGEN:END -->
 *
 *   upsertMarkerBlock(theme):
 *     block present? ──▶ replace in place (idempotent)
 *     absent?        ──▶ insert once before </head> (else </body>; else throw)
 *   removeMarkerBlock(theme): strip the block + the newline we inserted with it
 *
 * Insertion before </head> is byte-identically reversible: the newline that
 * already precedes </head> stays put, and we strip exactly what we added.
 */

export const SNIPPET_NAME = "schemagen-jsonld";
export const MARKER_START = "<!-- SCHEMAGEN:START -->";
export const MARKER_END = "<!-- SCHEMAGEN:END -->";
export const MARKER_BLOCK = `${MARKER_START}{% render '${SNIPPET_NAME}' %}${MARKER_END}`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches the whole START..END region, non-greedy so adjacent blocks (which
// should never happen) don't merge.
const BLOCK_RE = new RegExp(
  `${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`
);

// Same region plus the trailing newline insertion adds, for clean removal.
// `(?:\r?\n)?` tolerates both LF and CRLF themes so removal is byte-identical
// regardless of the host file's line endings.
const BLOCK_RE_WITH_NEWLINE = new RegExp(
  `${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}(?:\\r?\\n)?`
);

export function hasMarkerBlock(themeLiquid: string): boolean {
  return BLOCK_RE.test(themeLiquid);
}

/**
 * Ensure the SchemaGen include is present exactly once. Safe to run repeatedly:
 * if the block already exists it is replaced in place (so a changed snippet name
 * or format reconciles), never appended.
 */
export function upsertMarkerBlock(themeLiquid: string): string {
  if (BLOCK_RE.test(themeLiquid)) {
    return themeLiquid.replace(BLOCK_RE, MARKER_BLOCK);
  }
  // Match the host file's line ending so insert+remove round-trips byte-for-byte.
  const nl = /\r\n/.test(themeLiquid) ? "\r\n" : "\n";
  const headIdx = themeLiquid.search(/<\/head>/i);
  if (headIdx !== -1) {
    return (
      themeLiquid.slice(0, headIdx) +
      MARKER_BLOCK +
      nl +
      themeLiquid.slice(headIdx)
    );
  }
  const bodyIdx = themeLiquid.search(/<\/body>/i);
  if (bodyIdx !== -1) {
    return (
      themeLiquid.slice(0, bodyIdx) +
      MARKER_BLOCK +
      nl +
      themeLiquid.slice(bodyIdx)
    );
  }
  // A real theme.liquid always has </head> or </body>. Refuse to blind-append
  // (it wouldn't be reliably reversible and the include placement would be wrong).
  throw new Error(
    "theme.liquid has no </head> or </body> to anchor the SchemaGen include"
  );
}

/** Remove the SchemaGen block, restoring theme.liquid to its pre-install state. */
export function removeMarkerBlock(themeLiquid: string): string {
  return themeLiquid.replace(BLOCK_RE_WITH_NEWLINE, "");
}
