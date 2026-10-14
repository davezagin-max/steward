"use client";

import { formatInt } from "@/lib/steward/format";
import type { Counts, ItemValue, ReviewItem } from "@/lib/steward/review";
import { describeRule } from "@/lib/steward/rules";
import { Button, Icon, type IconName } from "./ui";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: "chart", title: "Code profiles the data", text: "Blanks, formats, and outliers in every column, measured by DuckDB." },
  { icon: "sparkle", title: "Claude suggests", text: "A description, a sensitivity label, and quality rules for each column." },
  { icon: "person", title: "A person approves each one", text: "Approve, edit, or reject. Only approved items are exported." },
];

/** "the description Claude suggested for loan_id", in words a newcomer can follow. */
export function describeItem(item: ReviewItem, value: ItemValue): string {
  switch (item.kind) {
    case "definition":
      return `the description Claude suggested for ${item.column}`;
    case "classification":
      return `the sensitivity label Claude suggested for ${item.column}`;
    case "rule":
      return value.kind === "rule" ? `the rule “${describeRule(value.rule)}”` : "a suggested rule";
    case "relationship":
      return `a link Claude found between ${item.columns.join(", ")}`;
  }
}

export type OverviewProps = {
  /** The dataset in one plain sentence. */
  dataset: string;
  counts: Counts;
  /** The suggestion being reviewed, with its current value. */
  current: { item: ReviewItem; value: ItemValue } | null;
  /** What just happened to the previous suggestion ("Approved."), if anything. */
  note: string | null;
  onStart: () => void;
  onSkip: () => void;
  onSeeContract: () => void;
  onRunAssessment: () => void;
};

/**
 * The first thing on the page: what Steward is, what the screen shows, and the one action
 * to take. While a review is under way it narrates which suggestion is up.
 */
export function Overview({ dataset, counts, current, note, onStart, onSkip, onSeeContract, onRunAssessment }: OverviewProps) {
  const decided = counts.approved + counts.rejected;
  let narration: string;
  let action: { label: string; icon: IconName; onClick: () => void; primary: boolean };
  if (counts.total === 0) {
    narration = "No suggestions yet. Run the Claude assessment to get some.";
    action = { label: "Run the assessment", icon: "play", onClick: onRunAssessment, primary: true };
  } else if (counts.pending === 0) {
    narration = `${note ? `${note} ` : ""}All ${formatInt(counts.total)} suggestions are decided, so the exports are complete.`;
    action = { label: "See the data contract", icon: "chevron", onClick: onSeeContract, primary: true };
  } else if (current) {
    narration = `${note ? `${note} ` : ""}Now reviewing ${describeItem(current.item, current.value)}. Approve, edit, or reject it.`;
    action = { label: "Skip to the next one", icon: "chevron", onClick: onSkip, primary: false };
  } else if (decided > 0) {
    narration = `${formatInt(counts.pending)} of ${formatInt(counts.total)} suggestions are still waiting for a decision.`;
    action = { label: "Continue reviewing", icon: "play", onClick: onStart, primary: true };
  } else {
    narration = `${formatInt(counts.total)} suggestions are waiting for you.`;
    action = { label: "Start reviewing", icon: "play", onClick: onStart, primary: true };
  }

  return (
    <section aria-labelledby="overview-title" className="overflow-hidden rounded-lg border border-border bg-bg">
      <div className="flex flex-col gap-3 p-4 sm:px-5 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="min-w-0">
          <h2 id="overview-title" className="text-lg font-semibold leading-snug tracking-tight sm:text-xl">
            Claude drafts the documentation and quality checks for a dataset.{" "}
            <span className="sm:block">A person approves every suggestion.</span>
          </h2>
          <p className="mt-1 text-[14px] text-muted">{dataset}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 md:w-72 md:items-end">
          <Button variant={action.primary ? "primary" : "secondary"} size="lg" onClick={action.onClick} className="w-full md:w-auto">
            <Icon name={action.icon} />
            {action.label}
          </Button>
          <p aria-live="polite" className="text-xs leading-snug text-muted md:text-right">
            {narration}
          </p>
        </div>
      </div>
      <ol aria-label="How it works" className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="relative flex items-start gap-3 bg-bg px-4 py-3 sm:px-5">
            {index > 0 && (
              <span
                aria-hidden
                className="absolute -left-2.5 top-1/2 z-10 hidden size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg text-muted sm:flex"
              >
                <Icon name="chevron" className="size-3" />
              </span>
            )}
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
              <Icon name={step.icon} className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold">{step.title}</span>
              <span className="block text-xs leading-snug text-muted">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
