"use client";

import { createContext, useContext, useState, useCallback } from "react";
import type { OptimizeResponse } from "@/lib/optimizer/types";

export type ScanStep =
  | "idle"
  | "fetching"
  | "extracting"
  | "validating"
  | "analyzing"
  | "refining"
  | "scoring"
  | "done"
  | "error";

interface ScanState {
  url: string;
  step: ScanStep;
  results: OptimizeResponse | null;
  error: string | null;
}

interface ScanContextValue extends ScanState {
  startScan: (url: string) => Promise<void>;
  clearResults: () => void;
}

const ScanContext = createContext<ScanContextValue | null>(null);

const STEP_DELAYS: [ScanStep, number][] = [
  ["fetching", 0],
  ["extracting", 1200],
  ["validating", 2000],
  ["analyzing", 3000],
  ["refining", 5000],
];

export function ScanProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ScanState>({
    url: "",
    step: "idle",
    results: null,
    error: null,
  });

  const startScan = useCallback(async (url: string) => {
    setState({ url, step: "fetching", results: null, error: null });

    // Simulate progress steps while the real request runs
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [step, delay] of STEP_DELAYS) {
      if (delay > 0) {
        timers.push(
          setTimeout(() => {
            setState((s) =>
              s.step !== "done" && s.step !== "error" ? { ...s, step } : s
            );
          }, delay)
        );
      }
    }

    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      timers.forEach(clearTimeout);

      const data = await res.json();

      if (!res.ok) {
        setState((s) => ({
          ...s,
          step: "error",
          error: data.error ?? "Optimization failed",
        }));
        return;
      }

      // Brief "scoring" step for visual feedback
      setState((s) => ({ ...s, step: "scoring" }));
      await new Promise((resolve) => setTimeout(resolve, 400));

      setState({
        url,
        step: "done",
        results: data as OptimizeResponse,
        error: null,
      });
    } catch {
      timers.forEach(clearTimeout);
      setState((s) => ({
        ...s,
        step: "error",
        error: "Network error — please try again",
      }));
    }
  }, []);

  const clearResults = useCallback(() => {
    setState({ url: "", step: "idle", results: null, error: null });
  }, []);

  return (
    <ScanContext.Provider value={{ ...state, startScan, clearResults }}>
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error("useScan must be used within ScanProvider");
  return ctx;
}
