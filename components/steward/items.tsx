"use client";

import { useId, useState, type ReactNode } from "react";
import { resultFor } from "@/lib/steward/exports";
import { formatInt, formatPct, plural } from "@/lib/steward/format";
import { decisionOf, type ItemValue, type ReviewItem } from "@/lib/steward/review";
import { describeRule, ruleLabel, validateRule } from "@/lib/steward/rules";
import {
  SENSITIVITIES,
  SEVERITIES,
  type FieldSpec,
  type Rule,
  type RuleResult,
  type Sensitivity,
  type Severity,
} from "@/lib/steward/types";
import { useWorkspace } from "./context";
import { Button, Chip, Code, Icon, PassFailBar, RawValue, SensitivityChip, SeverityChip, StatusChip } from "./ui";

const FIELD =
  "w-full rounded-md border border-border-strong bg-bg px-2 py-1.5 text-[13px] text-fg placeholder:text-muted";

/** Approve / Edit / Reject while pending; Reopen once decided. */
export function ItemActions({
  item,
  onEdit,
  className = "",
}: {
  item: ReviewItem;
  onEdit?: () => void;
  className?: string;
}) {
  const { review, act } = useWorkspace();
  const { status } = decisionOf(review, item);
  return (
    <div className={`flex shrink-0 flex-wrap items-center gap-1.5 ${className}`}>
      {status === "pending" ? (
        <>
          <Button variant="primary" size="sm" onClick={() => act({ type: "approve", ids: [item.id] })}>
            <Icon name="check" className="size-3" />
            Approve
          </Button>
          {onEdit && (
            <Button size="sm" onClick={onEdit}>
              <Icon name="pencil" className="size-3" />
              Edit
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={() => act({ type: "reject", ids: [item.id] })}>
            <Icon name="x" className="size-3" />
            Reject
          </Button>
        </>
      ) : (
        <>
          {onEdit && (
            <Button size="sm" onClick={onEdit}>
              <Icon name="pencil" className="size-3" />
              Edit
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => act({ type: "reopen", ids: [item.id] })}>
            <Icon name="undo" className="size-3" />
            Reopen
          </Button>
        </>
      )}
    </div>
  );
}

function EditFooter({
  error,
  onCancel,
  onSave,
}: {
  error: string | null;
  onCancel: () => void;
  onSave: (approve: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="sm" onClick={() => onSave(true)}>
        Save and approve
      </Button>
      <Button size="sm" onClick={() => onSave(false)}>
        Save as pending
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <p role="alert" className="min-h-4 text-xs text-danger">
        {error}
      </p>
    </div>
  );
}

/** The business definition of a column, with inline editing. */
export function DefinitionBlock({ item }: { item: ReviewItem }) {
  const { review, act } = useWorkspace();
  const decision = decisionOf(review, item);
  const text = decision.value.kind === "definition" ? decision.value.text : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  function save(approve: boolean) {
    const next = (draft ?? "").trim();
    if (next.length < 3) return setError("Write a definition first.");
    if (next.length > 600) return setError("Keep the definition under 600 characters.");
    act({ type: "edit", id: item.id, value: { kind: "definition", text: next }, approve });
    setDraft(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {draft === null ? (
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Business definition</h4>
        ) : (
          <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Business definition
          </label>
        )}
        <StatusChip status={decision.status} edited={decision.edited} />
      </div>
      {draft === null ? (
        <>
          <p className={`text-[14px] leading-relaxed ${decision.status === "rejected" ? "text-muted line-through" : ""}`}>
            {text}
          </p>
          <ItemActions item={item} onEdit={() => setDraft(text)} />
        </>
      ) : (
        <>
          <textarea
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            maxLength={600}
            className={FIELD}
          />
          <EditFooter error={error} onCancel={() => (setDraft(null), setError(null))} onSave={save} />
        </>
      )}
    </div>
  );
}

/** The sensitivity class of a column, with inline editing. */
export function ClassificationBlock({ item }: { item: ReviewItem }) {
  const { review, act } = useWorkspace();
  const decision = decisionOf(review, item);
  const current = decision.value.kind === "classification" ? decision.value.sensitivity : "Internal";
  const [draft, setDraft] = useState<Sensitivity | null>(null);
  const inputId = useId();

  function save(approve: boolean) {
    act({ type: "edit", id: item.id, value: { kind: "classification", sensitivity: draft ?? current }, approve });
    setDraft(null);
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {draft === null ? (
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Sensitivity class</h4>
        ) : (
          <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Sensitivity class
          </label>
        )}
        <StatusChip status={decision.status} edited={decision.edited} />
      </div>
      {draft === null ? (
        <>
          <div className={`flex items-center gap-2 ${decision.status === "rejected" ? "opacity-60" : ""}`}>
            <SensitivityChip value={current} proposed={decision.status !== "approved"} />
            <span className="text-[13px] text-muted">{SENSITIVITY_HELP[current]}</span>
          </div>
          <ItemActions item={item} onEdit={() => setDraft(current)} />
        </>
      ) : (
        <>
          <select
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value as Sensitivity)}
            className={`${FIELD} max-w-56`}
          >
            {SENSITIVITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <p className="text-[13px] text-muted">{SENSITIVITY_HELP[draft]}</p>
          <EditFooter error={null} onCancel={() => setDraft(null)} onSave={save} />
        </>
      )}
    </div>
  );
}

export const SENSITIVITY_HELP: Record<Sensitivity, string> = {
  Public: "Safe to publish.",
  Internal: "Business data with no personal information.",
  Confidential: "Personal or financial data; need-to-know access.",
  Restricted: "Direct identifiers and regulated data; masked by default.",
};

function fieldValueToText(spec: FieldSpec, value: unknown): string {
  if (spec.kind === "text_list") return Array.isArray(value) ? value.join("\n") : "";
  if (spec.kind === "optional_number" || spec.kind === "number") return value === null || value === undefined ? "" : String(value);
  return typeof value === "string" ? value : "";
}

/** One form control per catalog field kind. The catalog comes from the Python service. */
function RuleField({
  spec,
  value,
  columns,
  onChange,
}: {
  spec: FieldSpec;
  value: unknown;
  columns: string[];
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  const label = (
    <label htmlFor={id} className="text-xs font-medium">
      {spec.label}
    </label>
  );
  const help = spec.help && <p className="text-[11px] text-muted">{spec.help}</p>;
  let control: ReactNode;
  switch (spec.kind) {
    case "column":
      control = (
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} className={`${FIELD} font-mono`}>
          <option value="" disabled>
            Choose a column
          </option>
          {columns.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      );
      break;
    case "columns": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div className="flex flex-col gap-1.5">
          {selected.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {selected.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => onChange(selected.filter((entry) => entry !== name))}
                    className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-xs hover:bg-danger-soft"
                    aria-label={`Remove ${name}`}
                  >
                    {name}
                    <Icon name="x" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <select
            id={id}
            value=""
            onChange={(e) => e.target.value && onChange([...selected, e.target.value])}
            className={`${FIELD} font-mono`}
          >
            <option value="">Add a column</option>
            {columns
              .filter((name) => !selected.includes(name))
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        </div>
      );
      break;
    }
    case "number":
    case "optional_number":
      control = (
        <input
          id={id}
          type="number"
          step="any"
          inputMode="decimal"
          value={fieldValueToText(spec, value)}
          onChange={(e) => {
            const text = e.target.value.trim();
            onChange(text === "" ? null : Number(text));
          }}
          className={`${FIELD} font-mono`}
        />
      );
      break;
    case "text":
      control = (
        <input
          id={id}
          type="text"
          spellCheck={false}
          maxLength={200}
          value={fieldValueToText(spec, value)}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD} font-mono`}
        />
      );
      break;
    case "text_list":
      control = (
        <textarea
          id={id}
          rows={4}
          spellCheck={false}
          value={fieldValueToText(spec, value)}
          // Lines are kept exactly as typed: a trailing space is a different value.
          onChange={(e) => onChange(e.target.value.split("\n").filter((line) => line.length > 0))}
          className={`${FIELD} font-mono`}
        />
      );
      break;
    case "boolean":
      return (
        <label className="flex items-center gap-2 self-end pb-1.5 text-[13px]">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          {spec.label}
        </label>
      );
    case "choice":
      control = (
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} className={FIELD}>
          {spec.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      );
      break;
  }
  return (
    <div className={`flex flex-col gap-1 ${spec.kind === "text_list" || spec.kind === "columns" ? "sm:col-span-2" : ""}`}>
      {label}
      {control}
      {help}
    </div>
  );
}

function RuleForm({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const { review, act, bundle, columns } = useWorkspace();
  const decision = decisionOf(review, item);
  const start = decision.value as Extract<ItemValue, { kind: "rule" }>;
  const spec = bundle.catalog.find((entry) => entry.type === start.rule.type);
  const [draft, setDraft] = useState<Rule>(start.rule);
  const [severity, setSeverity] = useState<Severity>(start.severity);
  const [error, setError] = useState<string | null>(null);
  const severityId = useId();
  if (!spec) return null;

  function save(approve: boolean) {
    const checked = validateRule(draft, columns, bundle.catalog);
    if (!checked.ok) return setError(checked.error);
    act({ type: "edit", id: item.id, value: { kind: "rule", rule: checked.rule, severity }, approve });
    onDone();
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
      <p className="text-xs text-muted">
        <span className="font-medium text-fg">{spec.label}.</span> {spec.summary}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {spec.fields.map((field) => (
          <RuleField
            key={field.name}
            spec={field}
            value={draft[field.name]}
            columns={columns}
            onChange={(value) => (setDraft({ ...draft, [field.name]: value }), setError(null))}
          />
        ))}
        <div className="flex flex-col gap-1">
          <label htmlFor={severityId} className="text-xs font-medium">
            Severity
          </label>
          <select id={severityId} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={FIELD}>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>
      <EditFooter error={error} onCancel={onDone} onSave={save} />
    </div>
  );
}

function Value({ value }: { value: string | null }) {
  if (value === null) return <span className="italic text-muted">empty</span>;
  return <RawValue value={value} />;
}

function FailingRows({ result }: { result: RuleResult }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Sample of rows that fail this rule</caption>
        <thead className="bg-surface text-muted">
          <tr>
            <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
              row
            </th>
            {result.sample_columns.map((name) => (
              <th key={name} scope="col" className="px-2.5 py-1.5 font-mono font-medium">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.samples.map((sample) => (
            <tr key={sample.row} className="border-t border-border">
              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-muted">{formatInt(sample.row)}</td>
              {result.sample_columns.map((name) => (
                <td key={name} className="px-2.5 py-1.5">
                  <Value value={sample.values[name] ?? null} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleOutcome({ item, rule, result }: { item: ReviewItem; rule: Rule; result: RuleResult | null }) {
  const { apiAvailable, rerun, reruns } = useWorkspace();
  const state = reruns[item.id];
  if (result) {
    return (
      <div className="flex flex-col gap-1">
        <p className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
          <span className={result.failed ? "font-semibold text-danger" : "font-medium text-success"}>
            {result.failed ? `${formatInt(result.failed)} fail` : "All pass"}
          </span>
          <span className="text-muted">
            {result.pass_rate === null ? "no rows to check" : `${formatPct(result.pass_rate, 2)} of ${formatInt(result.evaluated)}`}
          </span>
        </p>
        <PassFailBar passed={result.passed} failed={result.failed} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1.5 text-xs">
      <p className="font-medium text-warn">Not run since the edit</p>
      {state?.status === "running" ? (
        <p className="text-muted" role="status">
          Running on the dataset…
        </p>
      ) : apiAvailable ? (
        <Button size="sm" onClick={() => rerun(item, rule)}>
          <Icon name="play" className="size-3" />
          Run rule
        </Button>
      ) : (
        <p className="text-muted">Running an edited rule needs the Steward API, which this demo runs without.</p>
      )}
      {state?.status === "error" && (
        <p role="alert" className="text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}

/** One proposed rule: what it checks, how the data did, and the reviewer's decision. */
export function RuleCard({ item, showSource = false }: { item: ReviewItem; showSource?: boolean }) {
  const { review, results, bundle } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const decision = decisionOf(review, item);
  if (decision.value.kind !== "rule") return null;
  const { rule, severity } = decision.value;
  const result = resultFor(results, item.id, rule);

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2.5">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone="accent">{ruleLabel(rule, bundle.catalog)}</Chip>
            <SeverityChip severity={severity} />
            {showSource && item.source === "relationship_pass" && <Chip>cross-column</Chip>}
            <StatusChip status={decision.status} edited={decision.edited} />
          </div>
          <p className={`mt-1.5 break-words text-[14px] font-medium ${decision.status === "rejected" ? "text-muted line-through" : ""}`}>
            {describeRule(rule)}
          </p>
          {item.rationale && <p className="mt-0.5 text-[13px] text-muted">{item.rationale}</p>}
        </div>
        <div className="w-full sm:w-52">
          <RuleOutcome item={item} rule={rule} result={result} />
        </div>
        {!editing && <ItemActions item={item} onEdit={() => setEditing(true)} className="w-full lg:w-auto" />}
      </div>

      {editing && <RuleForm item={item} onDone={() => setEditing(false)} />}

      {!editing && (
        <div className="mt-2 flex flex-col gap-1">
          {result && result.failed > 0 && (
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-accent-ink hover:underline [&::-webkit-details-marker]:hidden">
                <Icon name="chevron" className="size-3 transition-transform group-open:rotate-90" />
                Failing rows ({Math.min(result.samples.length, result.failed)} of {formatInt(result.failed)})
              </summary>
              <FailingRows result={result} />
            </details>
          )}
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
              <Icon name="chevron" className="size-3 transition-transform group-open:rotate-90" />
              Rule as data{result?.sql ? " and compiled SQL" : ""}
            </summary>
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <pre className="overflow-x-auto rounded-md border border-border bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed">
                {JSON.stringify(rule, null, 2)}
              </pre>
              {result?.sql && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed">
                    {result.sql}
                    {Object.keys(result.params).length > 0 && `\n\n-- bound parameters\n${JSON.stringify(result.params)}`}
                  </pre>
                  <p className="text-[11px] text-muted">
                    Written by the engine, not the model. Column names are checked against the dataset and quoted; values travel as bound parameters.
                  </p>
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </li>
  );
}

export function RuleList({ items, showSource = false }: { items: ReviewItem[]; showSource?: boolean }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <RuleCard key={item.id} item={item} showSource={showSource} />
      ))}
    </ul>
  );
}

/** A rule the validator refused. It is shown, never executed. */
export function RejectedRules({ rejected }: { rejected: { rule: unknown; reason: string }[] }) {
  if (rejected.length === 0) return null;
  return (
    <details className="group border-t border-border px-4 py-2.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-medium text-warn [&::-webkit-details-marker]:hidden">
        <Icon name="shield" className="size-3.5" />
        {plural(rejected.length, "suggested rule")} blocked by the validator
        <Icon name="chevron" className="size-3 transition-transform group-open:rotate-90" />
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {rejected.map((entry, index) => (
          <li key={index} className="rounded-md border border-border bg-surface p-2.5 text-xs">
            <Code className="break-all">{JSON.stringify(entry.rule)}</Code>
            <p className="mt-1 text-muted">{entry.reason} It never reached the engine.</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
