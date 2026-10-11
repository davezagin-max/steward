"use client";

import { useEffect, useRef } from "react";
import { formatTime } from "@/lib/steward/format";
import { valueSummary, type AuditAction, type AuditEntry } from "@/lib/steward/review";
import { useWorkspace } from "./context";
import { Button, Chip, Icon, StatusChip, type Tone } from "./ui";

const ACTION: Record<AuditAction, { label: string; tone: Tone }> = {
  approve: { label: "Approved", tone: "success" },
  reject: { label: "Rejected", tone: "danger" },
  edit: { label: "Edited", tone: "info" },
  reopen: { label: "Reopened", tone: "neutral" },
};

function Entry({ entry }: { entry: AuditEntry }) {
  const { label, tone } = ACTION[entry.action];
  const before = valueSummary(entry.before.value);
  const after = valueSummary(entry.after.value);
  return (
    <li className="flex flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <span className="font-mono tabular-nums">#{entry.seq}</span>
        <Chip tone={tone}>{label}</Chip>
        {entry.batch && <Chip title="Part of one bulk action">bulk</Chip>}
        <span>by {entry.actor}</span>
        <time dateTime={entry.at} className="ml-auto font-mono tabular-nums" title={entry.at}>
          {formatTime(entry.at)}
        </time>
      </div>
      <p className="break-words text-[13px] font-medium">{entry.label}</p>
      {entry.action === "edit" ? (
        <div className="flex flex-col gap-1 text-xs">
          <p className="break-words text-muted line-through">{before}</p>
          <p className="break-words">{after}</p>
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <StatusChip status={entry.before.status} />
          <span aria-label="became">→</span>
          <StatusChip status={entry.after.status} />
        </p>
      )}
    </li>
  );
}

/** Append-only log of every reviewer decision, newest first. */
export function AuditDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { review, act, bundle } = useWorkspace();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function exportLog() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(review.audit, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-log.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      aria-labelledby="audit-title"
      className="m-0 ml-auto h-dvh max-h-none w-[min(30rem,100vw)] max-w-none border-l border-border bg-bg p-0 text-fg shadow-2xl"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 id="audit-title" className="text-[15px] font-semibold">
              Audit log
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {review.audit.length} {review.audit.length === 1 ? "entry" : "entries"} for {bundle.dataset.name}. Each records who,
              what, when, and the value before and after.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close audit log">
            <Icon name="x" />
          </Button>
        </header>
        {review.audit.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <Icon name="history" className="size-6 text-muted" />
            <p className="text-[13px] font-medium">No decisions yet</p>
            <p className="max-w-xs text-xs text-muted">Approve, edit, reject, or reopen a suggestion and it is logged here.</p>
          </div>
        ) : (
          <ol className="flex-1 overflow-y-auto" reversed>
            {[...review.audit].reverse().map((entry) => (
              <Entry key={entry.seq} entry={entry} />
            ))}
          </ol>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button size="sm" disabled={review.audit.length === 0} onClick={exportLog}>
            <Icon name="download" className="size-3" />
            Download JSON
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={review.audit.length === 0}
            onClick={() => {
              if (window.confirm("Start the review over? Every decision and this log will be cleared.")) act({ type: "reset" });
            }}
          >
            Start over
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
