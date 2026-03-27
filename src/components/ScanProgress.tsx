"use client";

import type { ScanStep } from "@/components/ScanProvider";

const steps: { key: ScanStep; label: string }[] = [
  { key: "fetching", label: "Fetching page" },
  { key: "extracting", label: "Extracting schemas" },
  { key: "validating", label: "Running validation" },
  { key: "analyzing", label: "AI analyzing content" },
  { key: "scoring", label: "Computing score" },
];

function stepIndex(step: ScanStep): number {
  const idx = steps.findIndex((s) => s.key === step);
  return idx >= 0 ? idx : 0;
}

export default function ScanProgress({ currentStep }: { currentStep: ScanStep }) {
  const current = stepIndex(currentStep);

  return (
    <div className="mx-auto max-w-md py-16">
      <div className="flex flex-col gap-3">
        {steps.map((step, i) => {
          const isActive = i === current;
          const isDone = i < current;
          const isPending = i > current;

          return (
            <div key={step.key} className="flex items-center gap-3">
              {/* Indicator */}
              <div className="relative flex h-5 w-5 items-center justify-center">
                {isDone && (
                  <svg
                    className="h-4 w-4 text-valid"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
                {isActive && (
                  <div className="h-3 w-3 rounded-full bg-accent animate-pulse" />
                )}
                {isPending && (
                  <div className="h-2 w-2 rounded-full bg-surface-3" />
                )}
              </div>

              {/* Label */}
              <span
                className={`text-sm font-medium transition-colors ${
                  isActive
                    ? "text-text-primary"
                    : isDone
                      ? "text-text-secondary"
                      : "text-text-muted"
                }`}
              >
                {step.label}
                {isActive && (
                  <span className="ml-1 inline-block animate-pulse text-accent">
                    ...
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
