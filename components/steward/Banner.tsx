"use client";

import { DemoBanner } from "@/components/kit/DemoBanner";
import { apiBase } from "@/lib/steward/api";

/**
 * With the Steward API configured, the kit banner applies: add a key to go live. Without
 * it a key would do nothing, so the banner says what this deployment can and cannot do
 * instead of offering one.
 */
export function Banner({ placeholder }: { placeholder: boolean }) {
  if (apiBase()) return <DemoBanner placeholder={placeholder} />;
  return (
    <div role="status" className="border-b border-border bg-surface px-4 py-2 text-center text-sm">
      {placeholder
        ? "Demo mode: suggestions are sample output until a real Claude Opus 5.5 run is recorded."
        : "Demo mode: replaying a recorded Claude Opus 5.5 run."}{" "}
      <span className="text-muted">Live runs need the Steward API, which is not connected here.</span>
    </div>
  );
}
