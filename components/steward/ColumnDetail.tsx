"use client";

import { resultFor } from "@/lib/steward/exports";
import { epochDayToIso, formatCompact, formatInt, formatNumber, formatPct, formatShort, plural } from "@/lib/steward/format";
import { decisionOf, type ReviewItem } from "@/lib/steward/review";
import type { ColumnProfile, Histogram } from "@/lib/steward/types";
import { useWorkspace } from "./context";
import { ClassificationBlock, DefinitionBlock, RejectedRules, RuleList } from "./items";
import { Button, Card, Chip, Code, ConfidenceChip, Eyebrow, Icon, Notice, RawValue, SensitivityChip } from "./ui";

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "danger" | "warn" }) {
  // Long values (an ISO date) step down a size instead of being cut off.
  const size = value.length > 8 ? "text-[13px] leading-[22px]" : "text-[15px]";
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-bg px-3.5 py-2.5">
      <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd
        className={`truncate font-mono font-medium tabular-nums ${size} ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : ""}`}
        title={value}
      >
        {value}
      </dd>
      {note && <dd className="text-[11px] leading-snug text-muted">{note}</dd>}
    </div>
  );
}

/** Histogram as bars. Values beyond the plotted range are counted in the end caps. */
function Sparkbars({ histogram }: { histogram: Histogram }) {
  const max = Math.max(1, ...histogram.bins.map((bin) => bin.count), histogram.below, histogram.above);
  const label = (value: number) => (histogram.kind === "date" ? epochDayToIso(value) : formatCompact(value));
  const first = histogram.bins[0];
  const last = histogram.bins[histogram.bins.length - 1];
  const bar = (count: number, title: string, key: string, outside = false) => (
    <div key={key} className="flex h-full min-w-0 flex-1 items-end" title={title}>
      <div
        className={`w-full rounded-t-[2px] ${outside ? "bg-danger" : "bg-accent"} ${count === 0 ? "opacity-0" : ""}`}
        style={{ height: `${Math.max((count / max) * 100, count ? 4 : 0)}%` }}
      />
    </div>
  );
  return (
    <figure className="flex flex-col gap-1">
      <div
        className="flex h-20 items-end gap-[2px] border-b border-border-strong"
        role="img"
        aria-label={`Distribution from ${label(first.lo)} to ${label(last.hi)}${histogram.below + histogram.above ? `, with ${histogram.below + histogram.above} values outside that range` : ""}`}
      >
        {histogram.below > 0 && bar(histogram.below, `${formatInt(histogram.below)} below ${label(first.lo)}`, "below", true)}
        {histogram.bins.map((bin, index) =>
          bar(bin.count, `${label(bin.lo)} to ${label(bin.hi)}: ${formatInt(bin.count)}`, String(index)),
        )}
        {histogram.above > 0 && bar(histogram.above, `${formatInt(histogram.above)} above ${label(last.hi)}`, "above", true)}
      </div>
      <figcaption className="flex justify-between font-mono text-[11px] text-muted">
        <span>{label(first.lo)}</span>
        {histogram.below + histogram.above > 0 && (
          <span className="font-sans text-danger">{plural(histogram.below + histogram.above, "value")} outside the fences</span>
        )}
        <span>{label(last.hi)}</span>
      </figcaption>
    </figure>
  );
}

function TopValues({ column }: { column: ColumnProfile }) {
  const nonNull = column.row_count - column.null_count;
  const head = column.top_values.slice(0, 8);
  const rest = column.top_values.slice(8);
  const max = head[0]?.count ?? 1;
  const unlisted = column.distinct_count - column.top_values.length;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {head.map((entry) => (
          <li key={entry.value} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate">
              <RawValue value={entry.value} />
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max((entry.count / max) * 100, 1)}%` }} />
            </span>
            <span className="w-24 text-right font-mono tabular-nums text-muted">
              {formatInt(entry.count)} · {formatPct(entry.count / nonNull)}
            </span>
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <Icon name="chevron" className="size-3 transition-transform group-open:rotate-90" />
            {plural(rest.length + Math.max(unlisted, 0), "less common value")}
          </summary>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {rest.map((entry) => (
              <li key={entry.value} className="text-xs text-muted">
                <RawValue value={entry.value} /> ×{formatInt(entry.count)}
              </li>
            ))}
            {unlisted > 0 && <li className="text-xs text-muted">and {formatInt(unlisted)} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

function Shapes({ column }: { column: ColumnProfile }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {column.shapes.map((shape) => (
        <li key={shape.shape} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 text-xs">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <RawValue value={shape.shape} />
            <span className="min-w-0 break-all font-mono text-[11px] text-muted">{shape.regex}</span>
          </span>
          <span className="font-mono tabular-nums text-muted">
            {formatInt(shape.count)} · {formatPct(shape.pct, 2)}
          </span>
        </li>
      ))}
      {column.shape_count > column.shapes.length && (
        <li className="text-xs text-muted">and {plural(column.shape_count - column.shapes.length, "more shape")}</li>
      )}
    </ul>
  );
}

/** Deterministic findings from the profiler that deserve a sentence. */
function findings(column: ColumnProfile, profile: ReturnType<typeof useWorkspace>["bundle"]["profile"]): { tone: "warn" | "neutral"; text: string }[] {
  const found: { tone: "warn" | "neutral"; text: string }[] = [];
  if (column.invalid_count) {
    const shapes = column.invalid_shapes.map((shape) => `${shape.shape} ×${shape.count}`).join(", ");
    found.push({ tone: "warn", text: `${plural(column.invalid_count, "value")} do not parse as ${column.inferred_type}: ${shapes}.` });
  }
  if (column.outliers && column.outliers.below + column.outliers.above > 0) {
    const { below, above, lower_fence, upper_fence, examples } = column.outliers;
    found.push({
      tone: "warn",
      text: `${plural(below + above, "outlier")} beyond Tukey's far fences (${formatCompact(lower_fence)} to ${formatCompact(upper_fence)}): ${examples.join(", ")}.`,
    });
  }
  if (column.numeric?.negatives) found.push({ tone: "warn", text: `${plural(column.numeric.negatives, "negative value")}.` });
  if (column.dates?.future_count) {
    found.push({ tone: "neutral", text: `${plural(column.dates.future_count, "date")} after the as-of date ${profile.as_of}.` });
  }
  if (column.whitespace_count) {
    found.push({ tone: "warn", text: `${plural(column.whitespace_count, "value")} with leading or trailing spaces.` });
  }
  if (column.leading_zero_count && column.inferred_type === "string") {
    found.push({
      tone: "neutral",
      text: `${plural(column.leading_zero_count, "value")} are digits starting with zero, so the column is read as text, not as a number.`,
    });
  }
  for (const key of profile.candidate_keys) {
    if (!key.columns.includes(column.name)) continue;
    const others = key.columns.filter((name) => name !== column.name);
    const subject = others.length ? `Composite key candidate with ${others.join(", ")}` : "Key candidate";
    found.push({
      tone: key.exact ? "neutral" : "warn",
      text: key.exact
        ? `${subject}: unique on every row.`
        : `${subject}: ${formatPct(key.uniqueness, 2)} unique, ${plural(key.duplicate_groups, "duplicated value")}.`,
    });
  }
  for (const fd of profile.functional_dependencies) {
    if (fd.determinant !== column.name && fd.dependent !== column.name) continue;
    found.push({
      tone: fd.violations ? "warn" : "neutral",
      text: `${fd.determinant} determines ${fd.dependent}${fd.violations ? `, with ${plural(fd.violations, "exception")}` : " on every row"}.`,
    });
  }
  for (const order of profile.date_orderings) {
    if (order.before !== column.name && order.after !== column.name) continue;
    found.push({
      tone: order.violations ? "warn" : "neutral",
      text: `${order.before} comes before ${order.after}${order.violations ? `, except on ${plural(order.violations, "row")}` : " on every row"}.`,
    });
  }
  return found;
}

function ProfileCard({ column }: { column: ColumnProfile }) {
  const { bundle } = useWorkspace();
  const notes = findings(column, bundle.profile);
  const showShapes = column.shapes.length > 0 && (column.inferred_type === "string" || column.inferred_type === "date" || column.role === "identifier");
  const showValues = column.role === "category" && column.top_values.length > 0;
  const nonNull = column.row_count - column.null_count;
  return (
    <Card title="Profile" aside={<span className="text-[11px] text-muted">computed by DuckDB, not by the model</span>}>
      <dl className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
        <Stat
          label="Empty"
          value={formatPct(column.null_pct, 2)}
          note={`${formatInt(column.null_count)} of ${formatInt(column.row_count)} rows`}
          tone={column.null_pct > 0 && column.null_pct < 0.05 ? "warn" : undefined}
        />
        <Stat label="Distinct" value={formatInt(column.distinct_count)} note={`${formatPct(column.distinct_pct, 2)} of values`} />
        {column.inferred_type === "string" ? (
          <Stat label="Shapes" value={formatInt(column.shape_count)} note={column.shape_count === 1 ? "one format" : "value formats"} />
        ) : (
          <Stat
            label={`Valid ${column.inferred_type}`}
            value={formatPct(column.type_conformance, 2)}
            note={column.invalid_count ? `${formatInt(column.invalid_count)} do not parse` : `all ${formatInt(nonNull)} values`}
            tone={column.invalid_count ? "danger" : undefined}
          />
        )}
        {column.dates ? (
          <Stat label="Range" value={column.dates.min} note={`to ${column.dates.max}`} />
        ) : column.numeric ? (
          <Stat label="Median" value={formatShort(column.numeric.median)} note={`${formatShort(column.numeric.min)} to ${formatShort(column.numeric.max)}`} />
        ) : (
          <Stat
            label="Length"
            value={column.length ? (column.length.min === column.length.max ? String(column.length.min) : `${column.length.min}–${column.length.max}`) : "n/a"}
            note="characters"
          />
        )}
      </dl>
      <div className="flex flex-col gap-4 px-4 py-3.5">
        {column.histogram && !showValues && (
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Distribution</Eyebrow>
            <Sparkbars histogram={column.histogram} />
          </div>
        )}
        {showValues && (
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Values</Eyebrow>
            <TopValues column={column} />
          </div>
        )}
        {showShapes && (
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Patterns</Eyebrow>
            <Shapes column={column} />
          </div>
        )}
        {column.numeric && (
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs sm:grid-cols-5">
            {(
              [
                ["min", column.numeric.min],
                ["25th", column.numeric.p25],
                ["median", column.numeric.median],
                ["75th", column.numeric.p75],
                ["max", column.numeric.max],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[11px] text-muted">{label}</dt>
                <dd className="truncate font-mono tabular-nums" title={formatNumber(value)}>
                  {formatCompact(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {notes.length > 0 && (
          <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
            {notes.map((note) => (
              <li key={note.text} className="flex items-start gap-2 text-[13px]">
                <Icon name={note.tone === "warn" ? "alert" : "info"} className={`mt-0.5 size-3.5 ${note.tone === "warn" ? "text-warn" : "text-muted"}`} />
                <span className="min-w-0 break-words">{note.text}</span>
              </li>
            ))}
          </ul>
        )}
        {column.null_count === column.row_count && <p className="text-[13px] text-muted">Every value in this column is empty.</p>}
      </div>
    </Card>
  );
}

function ModelView({ column }: { column: ColumnProfile }) {
  const { bundle } = useWorkspace();
  const view = bundle.model_view.columns.find((entry) => entry.name === column.name);
  if (!view) return null;
  return (
    <details className="group rounded-lg border border-border bg-bg">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-[13px] font-semibold [&::-webkit-details-marker]:hidden">
        <Icon name="chevron" className="size-3.5 text-muted transition-transform group-open:rotate-90" />
        {bundle.run ? "What Claude was shown for this column" : "What Claude would be shown for this column"}
        <span className="font-normal text-muted">
          {column.sensitive
            ? "aggregates and shapes only; every raw value is masked"
            : "values" in view
              ? "aggregates, shapes, and the code list; never rows"
              : "aggregates and shapes; never rows"}
        </span>
      </summary>
      <div className="border-t border-border px-4 py-3">
        {column.sensitive && (
          <p className="mb-2 text-xs text-muted">Masked because: {column.sensitive_reasons.join("; ")}.</p>
        )}
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-[11.5px] leading-relaxed">
          {JSON.stringify(view, null, 2)}
        </pre>
      </div>
    </details>
  );
}

export function ColumnDetail({ name }: { name: string }) {
  const { bundle, items, review, results, columns, openColumn, act } = useWorkspace();
  const column = bundle.profile.columns.find((entry) => entry.name === name);
  if (!column) return null;
  const assessment = bundle.run?.assessments.find((entry) => entry.column === name);
  const failure = bundle.run?.failures.find((entry) => entry.column === name);
  const own = items.filter((item) => item.column === name);
  const definition = own.find((item) => item.kind === "definition");
  const classification = own.find((item) => item.kind === "classification");
  // Worst first: the rules the data breaks are the ones a reviewer came to see.
  const failed = (item: ReviewItem) => {
    const value = decisionOf(review, item).value;
    return value.kind === "rule" ? (resultFor(results, item.id, value.rule)?.failed ?? 0) : 0;
  };
  const worstFirst = (list: ReviewItem[]) => [...list].sort((a, b) => failed(b) - failed(a));
  const rules = worstFirst(own.filter((item) => item.kind === "rule"));
  const cross = worstFirst(items.filter((item) => item.kind === "rule" && item.column === null && item.columns.includes(name)));
  const pending = [...own, ...cross].filter((item) => decisionOf(review, item).status === "pending");
  const index = columns.indexOf(name);
  const classDecision = classification ? decisionOf(review, classification) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h2 className="break-all font-mono text-xl font-semibold tracking-tight">{column.name}</h2>
            <Chip>{column.inferred_type}</Chip>
            {column.role !== column.inferred_type && <Chip>{column.role}</Chip>}
            {classDecision?.value.kind === "classification" && classDecision.status !== "rejected" && (
              <SensitivityChip value={classDecision.value.sensitivity} proposed={classDecision.status !== "approved"} />
            )}
            <span className="text-[13px] text-muted">
              column {column.position} of {bundle.profile.column_count}
            </span>
          </div>
          {column.source_name !== column.name && (
            <p className="mt-1 text-[13px] text-muted">
              Header in the file: <Code>{column.source_name}</Code>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {pending.length > 1 && (
            <Button variant="primary" onClick={() => act({ type: "approve", ids: pending.map((item) => item.id) })}>
              <Icon name="check" />
              Approve all {pending.length} for this column
            </Button>
          )}
          <Button disabled={index <= 0} onClick={() => openColumn(columns[index - 1])} aria-label="Previous column">
            <Icon name="chevron" className="size-3.5 rotate-180" />
          </Button>
          <Button disabled={index >= columns.length - 1} onClick={() => openColumn(columns[index + 1])} aria-label="Next column">
            <Icon name="chevron" />
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <ProfileCard column={column} />
        <Card
          title="Suggested by Claude"
          aside={assessment && <ConfidenceChip confidence={assessment.confidence} />}
        >
          {assessment && definition && classification ? (
            <div className="divide-y divide-border">
              <DefinitionBlock item={definition} />
              <ClassificationBlock item={classification} />
              <div className="px-4 py-3">
                <Eyebrow>Why</Eyebrow>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{assessment.rationale}</p>
              </div>
            </div>
          ) : (
            <div className="p-4">
              {failure ? (
                <Notice tone="warn" title="Claude did not return a usable assessment for this column">
                  {failure.reason}
                </Notice>
              ) : (
                <Notice title="No suggestions yet">
                  The profile on the left is complete. Run the Claude assessment from “Use your own data” to get a definition, a
                  sensitivity class, and proposed rules for review.
                </Notice>
              )}
            </div>
          )}
        </Card>
      </div>

      {assessment && (
        <Card
          title={`Proposed rules for this column (${rules.length})`}
          aside={<span className="text-[11px] text-muted">counts from the rules engine on all {formatInt(column.row_count)} rows</span>}
        >
          {rules.length > 0 ? (
            <RuleList items={rules} />
          ) : (
            <p className="px-4 py-3 text-[13px] text-muted">No rules were proposed for this column.</p>
          )}
          <RejectedRules rejected={assessment.rejected_rules} />
        </Card>
      )}

      {cross.length > 0 && (
        <Card title={`Cross-column rules that involve ${column.name} (${cross.length})`}>
          <RuleList items={cross} showSource />
        </Card>
      )}

      <ModelView column={column} />
    </div>
  );
}
