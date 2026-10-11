"use client";

import { useEffect, useRef } from "react";
import { resultFor } from "@/lib/steward/exports";
import { formatInt } from "@/lib/steward/format";
import { decisionOf } from "@/lib/steward/review";
import { useWorkspace } from "./context";
import { Button, Chip, Icon, StatusChip } from "./ui";

/**
 * The answer key for the bundled sample: every problem the generator planted, how many
 * rows it touches, and whether the review has a rule that catches it. The same list
 * drives the engine's tests.
 */
export function SampleKey({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bundle, items, review, results, openColumn } = useWorkspace();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const rows = bundle.planted.map((issue) => {
    const item = items.find((candidate) => candidate.id === `rule:${issue.rule_id}`);
    const decision = item ? decisionOf(review, item) : null;
    const result = item && decision?.value.kind === "rule" ? resultFor(results, item.id, decision.value.rule) : null;
    return { issue, decision, found: result?.failed ?? null };
  });
  const caught = rows.filter((row) => row.found === row.issue.count).length;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      aria-labelledby="sample-key-title"
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(52rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border bg-bg p-0 text-fg shadow-2xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="sample-key-title" className="text-lg font-semibold">
              What is wrong with the sample
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] text-muted">
              The generator plants {bundle.planted.length} data problems in the loan tape and writes down the exact rows; the
              test suite checks the rules engine against that list row by row. Right now {caught} of {bundle.planted.length} have
              a rule in the review that fails exactly as many rows as were planted.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead className="bg-surface text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Planted problem</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Rows planted</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Rows the rule fails</th>
                <th scope="col" className="px-3 py-2 font-medium">Rule in the review</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ issue, decision, found }) => (
                <tr key={issue.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-left hover:text-accent-ink hover:underline"
                      onClick={() => {
                        onClose();
                        openColumn(issue.columns[0]);
                      }}
                    >
                      {issue.description}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{formatInt(issue.count)}</td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${found === issue.count ? "text-success" : "text-warn"}`}>
                    {found === null ? "n/a" : formatInt(found)}
                  </td>
                  <td className="px-3 py-2">
                    {decision ? <StatusChip status={decision.status} edited={decision.edited} /> : <Chip tone="warn">none suggested</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  );
}
