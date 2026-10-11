"use client";

import { useKey } from "./KeyProvider";

interface DemoBannerProps {
  /**
   * True while the fixtures are hand-written samples rather than recorded
   * model runs. The banner says so plainly instead of implying a real run.
   */
  placeholder?: boolean;
  /** Set to false for projects whose core features need no key at all. */
  aiRequired?: boolean;
}

export function DemoBanner({ placeholder = false, aiRequired = true }: DemoBannerProps) {
  const { isLive, openKeyModal } = useKey();

  if (isLive) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full bg-success" />
          Live — calling Claude Opus 5.5 with your key.
        </span>
        <button type="button" onClick={openKeyModal} className="underline underline-offset-2">
          Change key
        </button>
      </div>
    );
  }

  const message = !aiRequired
    ? "Everything here works without a key. Add one to turn on the Claude Opus 5.5 features."
    : placeholder
      ? "Demo mode — showing sample output until a real Claude Opus 5.5 run is recorded. Add your key to go live."
      : "Demo mode — replaying a recorded Claude Opus 5.5 run. Add your key to go live.";

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2 text-sm"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={openKeyModal}
        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
      >
        Add key
      </button>
    </div>
  );
}
