"use client";

import type { ScoreResult } from "@/lib/scoring/compute-score";

function ImprovementCard({
  icon,
  value,
  label,
  color,
  delay = 0,
}: {
  icon: string;
  value: number;
  label: string;
  color: "green" | "blue" | "amber";
  delay?: number;
}) {
  if (value === 0) return null;

  const colorMap = {
    green: "bg-valid/10 text-valid border-valid/20",
    blue: "bg-accent/10 text-accent border-accent/20",
    amber: "bg-warn/10 text-warn border-warn/20",
  };

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${colorMap[color]} animate-fade-in-up`}
      style={delay > 0 ? { animationDelay: `${delay}ms` } : undefined}
    >
      <span className="text-lg">{icon}</span>
      <div>
        <span className="text-2xl font-bold font-mono tabular-nums">{value}</span>
        <span className="ml-1.5 text-sm opacity-80">{label}</span>
      </div>
    </div>
  );
}

export default function ScoreHero({ score }: { score: ScoreResult }) {
  const hasImprovements =
    score.issuesResolved > 0 || score.schemasFixed > 0 || score.schemasAdded > 0;

  return (
    <div className="mb-6">
      {hasImprovements ? (
        <div className="flex flex-wrap gap-3">
          <ImprovementCard
            icon="&#x2714;&#xFE0F;"
            value={score.issuesResolved}
            label={score.issuesResolved === 1 ? "issue resolved" : "issues resolved"}
            color="green"
            delay={0}
          />
          <ImprovementCard
            icon="&#x1F527;"
            value={score.schemasFixed}
            label={score.schemasFixed === 1 ? "schema fixed" : "schemas fixed"}
            color="blue"
            delay={100}
          />
          <ImprovementCard
            icon="&#x2795;"
            value={score.schemasAdded}
            label={score.schemasAdded === 1 ? "schema added" : "schemas added"}
            color="amber"
            delay={200}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-valid/20 bg-valid/5 px-4 py-3">
          <p className="text-sm text-valid font-medium">
            &#x2728; Your schema markup looks great — no changes needed.
          </p>
        </div>
      )}
    </div>
  );
}
