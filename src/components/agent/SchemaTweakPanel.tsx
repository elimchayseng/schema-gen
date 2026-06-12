"use client";

/**
 * SchemaTweakPanel (issue #29) — conversational correction of LLM-generated
 * JSON-LD with sticky merchant overrides.
 *
 * Mounted inside AgentRunner's per-page detail view. The merchant types a plain
 * instruction ("the brand is Garner & Tow"), the chat endpoint turns it into
 * validated field edits, persists them as sticky overrides, and returns the
 * updated JSON-LD via onUpdated. Stored overrides survive every agent re-run.
 *
 * Design: indigo (--color-fix) accents for AI/fix actions, existing card motif
 * (rounded-lg border-border bg-surface-card), no orange.
 */

import { useCallback, useEffect, useState } from "react";
import {
  formatOverrideValue,
  prettyFieldPath,
  type MerchantOverrideDto,
  type ChatEditDto,
} from "./override-format";

export interface SchemaTweakPanelProps {
  siteId: string;
  url: string;
  /** @type of the node being tweaked, e.g. "Product". */
  schemaType: string;
  /** The current JSON-LD for this page (single node, array, or @graph doc). */
  jsonld: unknown;
  /** Called with the post-edit JSON-LD after a successful tweak. */
  onUpdated?: (updatedJsonld: unknown) => void;
}

export default function SchemaTweakPanel({
  siteId,
  url,
  schemaType,
  jsonld,
  onUpdated,
}: SchemaTweakPanelProps) {
  const [overrides, setOverrides] = useState<MerchantOverrideDto[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEdits, setLastEdits] = useState<ChatEditDto[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  const refreshOverrides = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/agent/overrides?siteId=${encodeURIComponent(siteId)}&url=${encodeURIComponent(url)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { overrides: MerchantOverrideDto[] };
      setOverrides(data.overrides ?? []);
    } catch {
      // List refresh is best-effort; the next action retries.
    }
  }, [siteId, url]);

  useEffect(() => {
    refreshOverrides();
  }, [refreshOverrides]);

  const sendTweak = useCallback(async () => {
    const instruction = message.trim();
    if (!instruction || sending) return;
    setSending(true);
    setError(null);
    setLastEdits([]);
    try {
      const res = await fetch("/api/agent/overrides/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId,
          url,
          schemaType,
          currentJsonld: jsonld,
          message: instruction,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        updatedJsonld?: unknown;
        edits?: ChatEditDto[];
      };
      if (!res.ok) {
        setError(data.error ?? "The correction could not be applied.");
        return;
      }
      setMessage("");
      setLastEdits(data.edits ?? []);
      await refreshOverrides();
      onUpdated?.(data.updatedJsonld);
    } catch {
      setError("Network error — the correction was not saved.");
    } finally {
      setSending(false);
    }
  }, [message, sending, siteId, url, schemaType, jsonld, onUpdated, refreshOverrides]);

  const removeOverride = useCallback(
    async (id: string) => {
      setDeletingId(id);
      setError(null);
      try {
        const res = await fetch(
          `/api/agent/overrides?id=${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setError(data?.error ?? "Could not remove the correction.");
          return;
        }
        setOverrides((prev) => prev.filter((o) => o.id !== id));
      } catch {
        setError("Network error — the correction was not removed.");
      } finally {
        setDeletingId(null);
      }
    },
    []
  );

  return (
    <div className="rounded-lg border border-border bg-surface-card p-5 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Tweak this schema
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            Tell the agent what to correct — your corrections stick across every
            future re-run.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-fix/20 px-2.5 py-0.5 text-xs font-medium text-fix-bright">
          {schemaType}
        </span>
      </div>

      {/* Current value preview */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          {showPreview ? "Hide" : "Show"} current schema
        </button>
        {showPreview && (
          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-surface-0 p-3 text-[11px] leading-relaxed text-text-secondary">
            {JSON.stringify(jsonld, null, 2)}
          </pre>
        )}
      </div>

      {/* Chat input */}
      <div className="mt-4 flex items-start gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendTweak();
            }
          }}
          placeholder="Tell the agent what to correct… e.g. “the brand is Garner & Tow”"
          disabled={sending}
          className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-fix focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={sendTweak}
          disabled={sending || message.trim().length === 0}
          className="shrink-0 rounded-md bg-fix px-4 py-2 text-sm font-bold text-text-primary transition-all hover:bg-fix-bright disabled:opacity-40"
        >
          {sending ? "Correcting…" : "Correct"}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="mt-3 rounded-md border border-error/30 bg-error-dim/20 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {/* Last applied edits */}
      {lastEdits.length > 0 && (
        <div className="mt-3 rounded-md border border-fix/30 bg-fix/10 px-3 py-2">
          <p className="text-xs font-medium text-fix-bright">
            Saved {lastEdits.length} correction{lastEdits.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1 space-y-0.5">
            {lastEdits.map((e) => (
              <li key={e.fieldPath} className="text-xs text-text-secondary">
                <span className="font-mono text-text-primary">
                  {prettyFieldPath(e.fieldPath)}
                </span>{" "}
                → {formatOverrideValue(e.value)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Active overrides */}
      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Your corrections ({overrides.length})
        </p>
        {overrides.length === 0 ? (
          <p className="mt-1.5 text-xs text-text-secondary">
            None yet. Anything you correct here overrides the agent’s value on
            every future run.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {overrides.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between gap-3 rounded-md bg-surface-1 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-text-primary">
                    <span className="font-mono text-fix-bright">
                      {prettyFieldPath(o.fieldPath)}
                    </span>{" "}
                    = {formatOverrideValue(o.value)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    {o.source === "chat" ? "Set via chat" : "Set manually"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeOverride(o.id)}
                  disabled={deletingId === o.id}
                  className="shrink-0 rounded-md border border-border bg-transparent px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-error/40 hover:text-error disabled:opacity-40"
                >
                  {deletingId === o.id ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
