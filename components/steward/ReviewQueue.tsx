"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { resultFor } from "@/lib/steward/exports";
import { formatInt } from "@/lib/steward/format";
import {
  countItems,
  decisionOf,
  itemLabel,
  relationshipLabel,
  type ItemKind,
  type ReviewItem,
  type Status,
} from "@/lib/steward/review";
import { describeRule } from "@/lib/steward/rules";
import type { Confidence } from "@/lib/steward/types";
import { useWorkspace } from "./context";
import { Button, Chip, Code, ConfidenceChip, Notice, SensitivityChip, SeverityChip, StatusChip } from "./ui";

const KIND_LABEL: Record<ItemKind, string> = {
  definition: "Definition",
  classification: "Classification",
  rule: "Rule",
  relationship: "Relationship",
};
const SELECT = "rounded-md border border-border-strong bg-bg px-2 py-1.5 text-[13px]";

function Summary({ item }: { item: ReviewItem }) {
  const { review, results } = useWorkspace();
  const { value } = decisionOf(review, item);
  if (value.kind === "classification") {
    return (
      <span className="inline-flex items-center gap-2">
        <Code>{item.column}</Code> is <SensitivityChip value={value.sensitivity} proposed={decisionOf(review, item).status !== "approved"} />
      </span>
    );
  }
  if (value.kind === "definition") {
    return (
      <span>
        <Code className="font-medium">{item.column}</Code>
        <span className="text-muted"> · </span>
        {value.text}
      </span>
    );
  }
  if (value.kind === "relationship") {
    return (
      <span>
        <span className="font-medium">{relationshipLabel(item.relationshipKind ?? "dependent_field")}</span>
        <span className="text-muted"> · </span>
        {value.description}
      </span>
    );
  }
  const result = resultFor(results, item.id, value.rule);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium">{describeRule(value.rule)}</span>
      <SeverityChip severity={value.severity} />
      {result ? (
        result.failed ? (
          <span className="text-xs font-semibold tabular-nums text-danger">{formatInt(result.failed)} fail</span>
        ) : (
          <span className="text-xs text-success">all pass</span>
        )
      ) : (
        <span className="text-xs text-warn">not run since edit</span>
      )}
    </span>
  );
}

export function ReviewQueue() {
  const { items, review, act, openColumn, openRelationships, bundle } = useWorkspace();
  const [status, setStatus] = useState<Status | "all">("pending");
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [confidence, setConfidence] = useState<Confidence | "all">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const counts = countItems(review, items);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      const decision = decisionOf(review, item);
      if (status !== "all" && decision.status !== status) return false;
      if (kind !== "all" && item.kind !== kind) return false;
      if (confidence !== "all" && item.confidence !== confidence) return false;
      if (needle && !`${item.columns.join(" ")} ${itemLabel(item, decision.value)}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, review, status, kind, confidence, query]);

  const shownIds = shown.map((item) => item.id);
  const chosen = shownIds.filter((id) => selected.has(id));
  const allChosen = shown.length > 0 && chosen.length === shown.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function decide(type: "approve" | "reject" | "reopen", ids: string[]) {
    act({ type, ids });
    setSelected(new Set());
  }

  function onRowKey(event: KeyboardEvent<HTMLLIElement>, item: ReviewItem) {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
    const row = event.currentTarget;
    const key = event.key.toLowerCase();
    if (key === "j" || key === "arrowdown") (row.nextElementSibling as HTMLElement | null)?.focus();
    else if (key === "k" || key === "arrowup") (row.previousElementSibling as HTMLElement | null)?.focus();
    else if (key === "a") act({ type: "approve", ids: [item.id] });
    else if (key === "r") act({ type: "reject", ids: [item.id] });
    else if (key === "u") act({ type: "reopen", ids: [item.id] });
    else if (key === "x" || key === " ") toggle(item.id);
    else return;
    event.preventDefault();
  }

  if (items.length === 0) {
    return (
      <Notice title="Nothing to review yet">
        This dataset has a profile but no suggestions. Run the Claude assessment from “Use your own data” and every suggestion will
        land here as pending.
      </Notice>
    );
  }

  const tabs: [Status | "all", string, number][] = [
    ["pending", "Pending", counts.pending],
    ["approved", "Approved", counts.approved],
    ["rejected", "Rejected", counts.rejected],
    ["all", "All", counts.total],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Review queue</h2>
          <p className="mt-1 max-w-2xl text-[13px] text-muted">
            Every suggestion waits here until a person decides. Only approved items reach the contract, the glossary, and the
            quality report.
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Filter by status" className="inline-flex rounded-md border border-border-strong p-0.5">
            {tabs.map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={status === value}
                onClick={() => setStatus(value)}
                className="rounded px-2.5 py-1 text-[13px] text-muted hover:text-fg aria-selected:bg-accent-soft aria-selected:font-medium aria-selected:text-accent-ink"
              >
                {label} <span className="tabular-nums opacity-80">{count}</span>
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="queue-kind">
            Kind
          </label>
          <select id="queue-kind" value={kind} onChange={(event) => setKind(event.target.value as ItemKind | "all")} className={SELECT}>
            <option value="all">All kinds</option>
            {(Object.keys(KIND_LABEL) as ItemKind[]).map((value) => (
              <option key={value} value={value}>
                {KIND_LABEL[value]}s
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="queue-confidence">
            Confidence
          </label>
          <select
            id="queue-confidence"
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as Confidence | "all")}
            className={SELECT}
          >
            <option value="all">Any confidence</option>
            <option value="high">High confidence</option>
            <option value="medium">Medium confidence</option>
            <option value="low">Low confidence</option>
          </select>
          <label className="sr-only" htmlFor="queue-search">
            Search
          </label>
          <input
            id="queue-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search column or text"
            className={`${SELECT} min-w-0 flex-1 basis-40 placeholder:text-muted`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-2 text-[13px]">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={allChosen}
              disabled={shown.length === 0}
              onChange={() => setSelected(allChosen ? new Set() : new Set(shownIds))}
              className="size-4 accent-[var(--accent)]"
            />
            {chosen.length ? `${chosen.length} selected` : `Select all ${shown.length} shown`}
          </label>
          <Button variant="primary" size="sm" disabled={chosen.length === 0} onClick={() => decide("approve", chosen)}>
            Approve selected
          </Button>
          <Button variant="danger" size="sm" disabled={chosen.length === 0} onClick={() => decide("reject", chosen)}>
            Reject selected
          </Button>
          <Button variant="ghost" size="sm" disabled={chosen.length === 0} onClick={() => decide("reopen", chosen)}>
            Reopen selected
          </Button>
          <p className="ml-auto hidden text-[11px] text-muted md:block">
            Focus a row, then <kbd className="font-mono">J</kbd>/<kbd className="font-mono">K</kbd> to move,{" "}
            <kbd className="font-mono">A</kbd> approve, <kbd className="font-mono">R</kbd> reject, <kbd className="font-mono">X</kbd>{" "}
            select
          </p>
        </div>
      </div>

      {shown.length === 0 ? (
        <Notice title={status === "pending" && counts.pending === 0 ? "Everything has been reviewed" : "No items match these filters"}>
          {status === "pending" && counts.pending === 0
            ? `${counts.approved} approved and ${counts.rejected} rejected. The exports for ${bundle.dataset.name} are complete.`
            : "Change the status, kind, or search to see more."}
        </Notice>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-bg" aria-label="Suggestions">
          {shown.map((item) => {
            const decision = decisionOf(review, item);
            return (
              <li
                key={item.id}
                tabIndex={0}
                onKeyDown={(event) => onRowKey(event, item)}
                className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 first:border-t-0 focus-visible:bg-surface focus-visible:outline-offset-[-2px] md:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  aria-label={`Select: ${itemLabel(item, decision.value)}`}
                  className="mt-1 size-4 accent-[var(--accent)]"
                />
                <div className="min-w-0 text-[13px]">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Chip>{KIND_LABEL[item.kind]}</Chip>
                    {item.kind === "rule" && item.source === "relationship_pass" && <Chip>cross-column</Chip>}
                    <ConfidenceChip confidence={item.confidence} />
                  </div>
                  <div className="line-clamp-2 break-words">
                    <Summary item={item} />
                  </div>
                </div>
                <div className="col-start-2 flex items-center md:col-start-auto md:pt-0.5">
                  <StatusChip status={decision.status} edited={decision.edited} />
                </div>
                <div className="col-start-2 flex flex-wrap items-center gap-1.5 md:col-start-auto">
                  {decision.status === "pending" ? (
                    <>
                      <Button variant="primary" size="sm" onClick={() => act({ type: "approve", ids: [item.id] })}>
                        Approve
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => act({ type: "reject", ids: [item.id] })}>
                        Reject
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => act({ type: "reopen", ids: [item.id] })}>
                      Reopen
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => (item.column ? openColumn(item.column) : openRelationships())}
                    aria-label={`Open ${item.column ?? "cross-column relationships"} to see details or edit`}
                  >
                    Open
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
