"use client";

import type { ReactNode } from "react";
import { useKey } from "@/components/kit/KeyProvider";
import { apiBase } from "@/lib/steward/api";
import { Icon } from "./ui";

function Bar({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 border-b border-border bg-surface px-4 py-1.5 text-center text-[13px] text-muted"
    >
      {children}
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded font-medium text-accent-ink underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {children}
    </button>
  );
}

/**
 * One calm line that says what is real. The fixture's placeholder flag picks the wording.
 * What a live run needs (the Steward API and a key) is explained in the "Use your own
 * data" panel, where an upload is attempted, so the first screen does not lead with it.
 */
export function Banner({ placeholder, onRunLive }: { placeholder: boolean; onRunLive: () => void }) {
  const { isLive, openKeyModal } = useKey();
  const connected = !!apiBase();

  if (connected && isLive) {
    return (
      <Bar>
        <span className="inline-flex items-center gap-2 text-fg">
          <span aria-hidden className="size-2 rounded-full bg-success" />
          Live: Claude Opus 5.5 runs with your key.
        </span>
        <LinkButton onClick={openKeyModal}>Change key</LinkButton>
      </Bar>
    );
  }

  const source = placeholder ? "Claude's suggestions here are pre-written examples" : "Claude's suggestions here are replayed from a recorded run";
  return (
    <Bar>
      <span className="inline-flex items-start gap-1.5">
        <Icon name="info" className="mt-[3px] size-3.5" />
        <span>
          <span className="font-medium text-fg">Demo:</span> {source}
          {connected ? (
            ". Add your Anthropic API key to run it live."
          ) : (
            <>
              <span className="sm:hidden">.</span>
              <span className="hidden sm:inline">; the profile and rule results are computed for real.</span>
            </>
          )}
        </span>
      </span>
      <LinkButton onClick={connected ? openKeyModal : onRunLive}>{connected ? "Add key" : "How to run it live"}</LinkButton>
    </Bar>
  );
}
