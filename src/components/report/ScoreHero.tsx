"use client";

import type { ScoreResult } from "@/lib/scoring/compute-score";

function ScoreDigit({ value, size = "lg" }: { value: number; size?: "lg" | "sm" }) {
  const color =
    value >= 80
      ? "text-valid"
      : value >= 50
        ? "text-accent"
        : "text-error";

  return (
    <span
      className={`font-mono font-bold tabular-nums ${color} ${
        size === "lg" ? "text-6xl leading-none" : "text-3xl leading-none"
      }`}
    >
      {value}
    </span>
  );
}

function SubScore({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 text-xs text-text-secondary">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-xs text-text-secondary tabular-nums w-10 text-right">
        {value}/{max}
      </span>
    </div>
  );
}

export default function ScoreHero({ score }: { score: ScoreResult }) {
  const hasBefore = score.before.total > 0;
  const deltaSign = score.delta > 0 ? "+" : "";

  return (
    <div className="mb-6">
      {/* Score display */}
      <div className="flex items-end gap-8 mb-4">
        <div className="flex items-end gap-4">
          {hasBefore && (
            <>
              <div className="flex flex-col items-center">
                <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">
                  Before
                </span>
                <ScoreDigit value={score.before.total} size="sm" />
              </div>
              <span className="text-2xl text-text-muted mb-1 font-mono">&rarr;</span>
            </>
          )}
          <div className="flex flex-col items-center">
            <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">
              {hasBefore ? "After" : "Score"}
            </span>
            <ScoreDigit value={score.after.total} />
          </div>
          {hasBefore && score.delta !== 0 && (
            <span
              className={`font-mono text-lg font-bold mb-2 ${
                score.delta > 0 ? "text-valid" : "text-error"
              }`}
            >
              {deltaSign}{score.delta}
            </span>
          )}
        </div>
      </div>

      {/* Summary line */}
      <p className="text-sm text-text-secondary mb-4">{score.summary}</p>

      {/* Sub-score bars */}
      <div className="flex flex-col gap-2 max-w-md">
        <SubScore label="Coverage" value={score.after.coverage} max={40} />
        <SubScore label="Quality" value={score.after.quality} max={40} />
        <SubScore label="Completeness" value={score.after.completeness} max={20} />
      </div>
    </div>
  );
}
