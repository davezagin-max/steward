"use client";

import { useId, useState } from "react";
import { formatInt, formatPct } from "@/lib/steward/format";
import { decisionOf, relationshipLabel, type ReviewItem } from "@/lib/steward/review";
import { useWorkspace } from "./context";
import { ItemActions, RejectedRules, RuleList, spotlightProps } from "./items";
import { Button, Card, Chip, ConfidenceChip, Eyebrow, Notice, StatusChip } from "./ui";

function ColumnLinks({ names }: { names: string[] }) {
  const { openColumn } = useWorkspace();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {names.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => openColumn(name)}
          className="rounded border border-border bg-surface px-1.5 py-px font-mono text-xs hover:border-accent hover:text-accent-ink"
        >
          {name}
        </button>
      ))}
    </span>
  );
}

function Facts() {
  const { bundle } = useWorkspace();
  const { candidate_keys: keys, functional_dependencies: dependencies, date_orderings: orderings } = bundle.profile;
  return (
    <Card title="What the profiler found" aside={<span className="text-[11px] text-muted">facts the model reasons from</span>}>
      <div className="grid gap-x-6 gap-y-4 p-4 xl:grid-cols-3">
        <div className="min-w-0">
          <Eyebrow>Candidate keys</Eyebrow>
          {keys.length ? (
            <ul className="mt-1.5 flex flex-col text-xs">
              {keys.map((key) => (
                <li key={key.columns.join("+")} className="flex flex-col gap-1 border-t border-border py-1.5 first:border-t-0">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <ColumnLinks names={key.columns} />
                    <span className={`font-mono tabular-nums ${key.duplicate_rows ? "text-danger" : "text-muted"}`}>
                      {formatPct(key.uniqueness, 2)} unique
                      {key.duplicate_rows ? ` · ${formatInt(key.duplicate_rows)} duplicate rows` : ""}
                    </span>
                  </span>
                  {key.expected_collisions !== null && (
                    <span className="text-[11px] text-muted">
                      About {formatInt(Math.round(key.expected_collisions))} duplicates would be expected if the columns were unrelated.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted">No column or small combination of columns is unique enough to be a key.</p>
          )}
        </div>
        <div className="min-w-0">
          <Eyebrow>One column determines another</Eyebrow>
          {dependencies.length ? (
            <ul className="mt-1.5 flex flex-col text-xs">
              {dependencies.map((fd) => (
                <li key={`${fd.determinant}>${fd.dependent}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-1.5 first:border-t-0">
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <ColumnLinks names={[fd.determinant]} />
                    <span aria-label="determines" className="text-muted">→</span>
                    <ColumnLinks names={[fd.dependent]} />
                  </span>
                  <span className={`font-mono tabular-nums ${fd.violations ? "text-danger" : "text-muted"}`}>
                    {fd.violations ? `${formatInt(fd.violations)} exceptions` : "no exceptions"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted">No categorical column determines another.</p>
          )}
        </div>
        <div className="min-w-0">
          <Eyebrow>Date order</Eyebrow>
          {orderings.length ? (
            <ul className="mt-1.5 flex flex-col text-xs">
              {orderings.map((order) => (
                <li key={`${order.before}<${order.after}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-1.5 first:border-t-0">
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <ColumnLinks names={[order.before]} />
                    <span className="text-muted">before</span>
                    <ColumnLinks names={[order.after]} />
                  </span>
                  <span className={`font-mono tabular-nums ${order.violations ? "text-danger" : "text-muted"}`}>
                    {order.violations ? `${formatInt(order.violations)} exceptions` : "no exceptions"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted">No pair of date columns has a consistent order.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function RelationshipCard({ item, rules }: { item: ReviewItem; rules: ReviewItem[] }) {
  const { review, act, bundle, spotlight } = useWorkspace();
  const decision = decisionOf(review, item);
  const description = decision.value.kind === "relationship" ? decision.value.description : "";
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const source = bundle.run?.relationships.find((entry) => entry.id === item.relationshipId);

  function save(approve: boolean) {
    const text = (draft ?? "").trim();
    if (text.length < 3) return;
    act({ type: "edit", id: item.id, value: { kind: "relationship", description: text }, approve });
    setDraft(null);
  }

  const marked = spotlightProps(spotlight, item.id);
  return (
    <Card>
      <div {...marked} className={`flex flex-col gap-2 rounded-t-lg px-4 py-3.5 ${marked.className}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Chip tone="accent">{relationshipLabel(item.relationshipKind ?? "dependent_field")}</Chip>
          <ColumnLinks names={item.columns} />
          <span className="ml-auto inline-flex items-center gap-2">
            <ConfidenceChip confidence={item.confidence} />
            <StatusChip status={decision.status} edited={decision.edited} />
          </span>
        </div>
        {draft === null ? (
          <p className={`text-[14px] font-medium ${decision.status === "rejected" ? "text-muted line-through" : ""}`}>{description}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <label htmlFor={inputId} className="sr-only">
              Relationship description
            </label>
            <textarea
              id={inputId}
              rows={2}
              maxLength={600}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-full rounded-md border border-border-strong bg-bg px-2 py-1.5 text-[13px]"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => save(true)}>
                Save and approve
              </Button>
              <Button size="sm" onClick={() => save(false)}>
                Save as pending
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <p className="text-[13px] leading-relaxed text-muted">{item.rationale}</p>
        {draft === null && <ItemActions item={item} onEdit={() => setDraft(description)} />}
      </div>
      {rules.length > 0 && (
        <div className="border-t border-border">
          <RuleList items={rules} />
        </div>
      )}
      {source && <RejectedRules rejected={source.rejected_rules} />}
    </Card>
  );
}

export function Relationships() {
  const { bundle, items } = useWorkspace();
  const relationships = items.filter((item) => item.kind === "relationship");
  const failure = bundle.run?.failures.find((entry) => entry.column === null);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">Cross-column relationships</h2>
        <p className="mt-1 max-w-3xl text-[13px] text-muted">
          Keys, date order, and fields that depend on each other. The profiler measures them; Claude&apos;s second pass, at high
          effort, explains which ones matter and proposes the rules that enforce them.
        </p>
      </header>
      <Facts />
      {failure && (
        <Notice tone="warn" title="The relationship pass did not return a usable result">
          {failure.reason}
        </Notice>
      )}
      {relationships.length > 0 ? (
        relationships.map((item) => (
          <RelationshipCard
            key={item.id}
            item={item}
            rules={items.filter((rule) => rule.kind === "rule" && rule.relationshipId === item.relationshipId)}
          />
        ))
      ) : (
        !failure && (
          <Notice title={bundle.run ? "Claude recorded no cross-column relationships" : "No relationship suggestions yet"}>
            {bundle.run
              ? "The facts above come from the profiler. The second pass did not find a key, ordering, or dependency worth documenting."
              : "The facts above come from the profiler. Run the Claude assessment to get relationships and rules to review."}
          </Notice>
        )
      )}
    </div>
  );
}
