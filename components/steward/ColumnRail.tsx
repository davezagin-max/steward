"use client";

import { useState } from "react";
import { resultFor } from "@/lib/steward/exports";
import { decisionOf } from "@/lib/steward/review";
import { useWorkspace } from "./context";
import { Icon, SensitivityChip } from "./ui";

export type Selection = { type: "column"; name: string } | { type: "relationships" };

function useColumnSummaries() {
  const { bundle, items, review, results } = useWorkspace();
  return bundle.profile.columns.map((column) => {
    const own = items.filter((item) => item.column === column.name);
    const classification = own.find((item) => item.kind === "classification");
    const decision = classification ? decisionOf(review, classification) : null;
    let failing = 0;
    for (const item of own) {
      const value = decisionOf(review, item).value;
      if (value.kind !== "rule" || decisionOf(review, item).status === "rejected") continue;
      if ((resultFor(results, item.id, value.rule)?.failed ?? 0) > 0) failing += 1;
    }
    return {
      column,
      pending: own.filter((item) => decisionOf(review, item).status === "pending").length,
      total: own.length,
      failing,
      sensitivity: decision?.value.kind === "classification" && decision.status !== "rejected" ? decision.value.sensitivity : null,
      approved: decision?.status === "approved",
    };
  });
}

/** Left rail on wide screens; a select on narrow ones. */
export function ColumnRail({ selection, onSelect }: { selection: Selection; onSelect: (selection: Selection) => void }) {
  const { bundle, items, review } = useWorkspace();
  const [query, setQuery] = useState("");
  const summaries = useColumnSummaries();
  const shown = summaries.filter((entry) => entry.column.name.includes(query.trim().toLowerCase()));
  const cross = items.filter((item) => item.column === null);
  const crossPending = cross.filter((item) => decisionOf(review, item).status === "pending").length;
  const selectedName = selection.type === "column" ? selection.name : null;

  return (
    <>
      <div className="lg:hidden">
        <label htmlFor="column-select" className="sr-only">
          Column
        </label>
        <select
          id="column-select"
          value={selection.type === "column" ? selection.name : "__relationships"}
          onChange={(event) =>
            onSelect(event.target.value === "__relationships" ? { type: "relationships" } : { type: "column", name: event.target.value })
          }
          className="w-full rounded-md border border-border-strong bg-bg px-2.5 py-2 font-mono text-[13px]"
        >
          <option value="__relationships">Cross-column relationships ({crossPending} pending)</option>
          {summaries.map((entry) => (
            <option key={entry.column.name} value={entry.column.name}>
              {entry.column.name}
              {entry.sensitivity ? ` · ${entry.sensitivity}` : ""}
              {entry.pending ? ` · ${entry.pending} pending` : ""}
            </option>
          ))}
        </select>
      </div>

      <nav
        aria-label="Columns"
        className="hidden max-h-[calc(100vh-1.5rem)] w-[272px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-bg lg:sticky lg:top-3 lg:flex"
      >
        <div className="border-b border-border p-2">
          <label htmlFor="column-search" className="sr-only">
            Filter columns
          </label>
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input
              id="column-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Filter ${bundle.profile.column_count} columns`}
              className="w-full rounded-md border border-border bg-bg py-1.5 pl-7 pr-2 text-[13px] placeholder:text-muted"
            />
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto p-1.5">
          <li>
            <button
              type="button"
              aria-current={selection.type === "relationships" ? "true" : undefined}
              onClick={() => onSelect({ type: "relationships" })}
              className="mb-1 flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium hover:bg-surface aria-[current]:bg-accent-soft aria-[current]:text-accent-ink"
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="link" />
                Cross-column
              </span>
              <span className="text-[11px] font-normal text-muted">
                {cross.length ? (crossPending ? `${crossPending} pending` : "reviewed") : "none"}
              </span>
            </button>
          </li>
          {shown.map(({ column, pending, total, failing, sensitivity, approved }) => (
            <li key={column.name}>
              <button
                type="button"
                aria-current={selectedName === column.name ? "true" : undefined}
                onClick={() => onSelect({ type: "column", name: column.name })}
                className="group flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-surface aria-[current]:bg-accent-soft"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[13px] font-medium group-aria-[current]:text-accent-ink">{column.name}</span>
                  {sensitivity && <SensitivityChip value={sensitivity} proposed={!approved} />}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span>{column.inferred_type}</span>
                  {total > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      {pending ? (
                        <span>{pending} pending</span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 text-success">
                          <Icon name="check" className="size-3" />
                          reviewed
                        </span>
                      )}
                    </>
                  )}
                  {failing > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-danger">
                        {failing} failing {failing === 1 ? "rule" : "rules"}
                      </span>
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-2.5 py-3 text-[13px] text-muted">No column matches “{query}”.</li>}
        </ul>
      </nav>
    </>
  );
}
