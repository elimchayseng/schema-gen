import { describe, it, expect } from "vitest";
import {
  MARKER_BLOCK,
  hasMarkerBlock,
  removeMarkerBlock,
  upsertMarkerBlock,
} from "../theme-liquid";

const THEME = `<!doctype html>
<html>
<head>
  <title>{{ shop.name }}</title>
</head>
<body>
  {{ content_for_layout }}
</body>
</html>
`;

describe("upsertMarkerBlock", () => {
  it("inserts the include before </head> when absent", () => {
    const out = upsertMarkerBlock(THEME);
    expect(out).toContain(MARKER_BLOCK);
    // placed immediately before </head>
    expect(out).toMatch(new RegExp(`${escape(MARKER_BLOCK)}\\n</head>`));
    expect(hasMarkerBlock(out)).toBe(true);
  });

  it("is idempotent — re-running is byte-identical", () => {
    const once = upsertMarkerBlock(THEME);
    const twice = upsertMarkerBlock(once);
    expect(twice).toBe(once);
  });

  it("replaces a stale block in place rather than appending a second", () => {
    const stale = THEME.replace(
      "</head>",
      "<!-- SCHEMAGEN:START -->{% render 'old-name' %}<!-- SCHEMAGEN:END -->\n</head>"
    );
    const out = upsertMarkerBlock(stale);
    expect(out).toContain(MARKER_BLOCK);
    expect(out).not.toContain("old-name");
    // exactly one block
    expect(out.match(/SCHEMAGEN:START/g)).toHaveLength(1);
  });

  it("falls back to </body> when there is no </head>", () => {
    const noHead = "<html><body>{{ content_for_layout }}</body></html>\n";
    const out = upsertMarkerBlock(noHead);
    expect(out).toMatch(new RegExp(`${escape(MARKER_BLOCK)}\\n</body>`));
  });

  it("throws when there is no </head> or </body> to anchor", () => {
    expect(() => upsertMarkerBlock("just some text\n")).toThrow(
      /no <\/head> or <\/body>/
    );
  });
});

describe("removeMarkerBlock", () => {
  it("restores the original theme.liquid byte-identically", () => {
    const installed = upsertMarkerBlock(THEME);
    expect(installed).not.toBe(THEME);
    expect(removeMarkerBlock(installed)).toBe(THEME);
  });

  it("is a no-op when no block is present", () => {
    expect(removeMarkerBlock(THEME)).toBe(THEME);
  });

  it("round-trips byte-identically on a CRLF theme", () => {
    const crlf = THEME.replace(/\n/g, "\r\n");
    const installed = upsertMarkerBlock(crlf);
    expect(installed).toContain("\r\n");
    expect(installed).not.toBe(crlf);
    expect(removeMarkerBlock(installed)).toBe(crlf);
  });

  it("removes a block regardless of its inner content", () => {
    const installed = THEME.replace(
      "</head>",
      "<!-- SCHEMAGEN:START -->{% render 'whatever' %}<!-- SCHEMAGEN:END -->\n</head>"
    );
    expect(removeMarkerBlock(installed)).toBe(THEME);
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
