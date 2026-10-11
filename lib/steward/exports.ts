/**
 * The three exports: data contract (YAML), business glossary (CSV), and data-quality
 * report (Markdown).
 *
 * All three are pure functions of the dataset profile, the rule results, and the review
 * state. They contain only what a reviewer approved: a pending or rejected suggestion
 * never appears, and no model is called to write them. Timestamps come from the audit
 * log, so the same review always produces the same files.
 */
import { toCsv } from "./csv";
import { formatInt, formatPct } from "./format";
import {
  countItems,
  decisionOf,
  relationshipLabel,
  type AuditEntry,
  type Decision,
  type ReviewItem,
  type ReviewState,
} from "./review";
import { describeRule, sameRule } from "./rules";
import type { Bundle, Rule, RuleResult, Severity } from "./types";
import { toYaml, type Yaml } from "./yaml";

export interface ExportContext {
  bundle: Bundle;
  items: ReviewItem[];
  state: ReviewState;
  /** Latest result per rule id, including re-runs of edited rules. */
  results: Record<string, RuleResult>;
}

export interface ApprovedRule {
  id: string;
  item: ReviewItem;
  rule: Rule;
  severity: Severity;
  edited: boolean;
  /** Null when the rule was edited after it last ran. */
  result: RuleResult | null;
}

/** The engine's result for a rule, but only if it ran against this exact version of it. */
export function resultFor(
  results: Record<string, RuleResult>,
  itemId: string,
  rule: Rule,
): RuleResult | null {
  const result = results[itemId.replace(/^rule:/, "")];
  return result && result.status !== "error" && sameRule(result.rule, rule) ? result : null;
}

function approved(ctx: ExportContext, kind: ReviewItem["kind"]): [ReviewItem, Decision][] {
  return ctx.items
    .filter((item) => item.kind === kind && decisionOf(ctx.state, item).status === "approved")
    .map((item) => [item, decisionOf(ctx.state, item)]);
}

export function approvedRules(ctx: ExportContext): ApprovedRule[] {
  return approved(ctx, "rule").flatMap(([item, decision]) =>
    decision.value.kind === "rule"
      ? [
          {
            id: item.id.replace(/^rule:/, ""),
            item,
            rule: decision.value.rule,
            severity: decision.value.severity,
            edited: decision.edited,
            result: resultFor(ctx.results, item.id, decision.value.rule),
          },
        ]
      : [],
  );
}

function lastApproval(audit: AuditEntry[], itemId: string): AuditEntry | undefined {
  return audit.findLast((entry) => entry.itemId === itemId && entry.action === "approve");
}

function ruleParams(rule: Rule): { [key: string]: Yaml } {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => key !== "type")) as { [key: string]: Yaml };
}

function ruleEntry(rule: ApprovedRule): Yaml {
  return {
    id: rule.id,
    type: rule.rule.type,
    severity: rule.severity,
    description: describeRule(rule.rule),
    params: ruleParams(rule.rule),
  };
}

/** The contract as plain data. Field order here is the order in the YAML file. */
export function buildContract(ctx: ExportContext): { [key: string]: Yaml | undefined } {
  const { bundle, state } = ctx;
  const counts = countItems(state, ctx.items);
  const rules = approvedRules(ctx);
  const definitions = new Map(approved(ctx, "definition").map(([item, d]) => [item.column, d.value]));
  const classes = new Map(approved(ctx, "classification").map(([item, d]) => [item.column, d.value]));
  const relationships = approved(ctx, "relationship");
  const lastDecision = state.audit.at(-1)?.at ?? null;

  const columnRules = (column: string) =>
    rules.filter((rule) => rule.item.source === "column_pass" && rule.item.column === column);

  const schema: Yaml[] = bundle.profile.columns.map((column) => {
    const own = columnRules(column.name);
    const definition = definitions.get(column.name);
    const classification = classes.get(column.name);
    const required = own.some((rule) => rule.rule.type === "not_null");
    const unique = own.some(
      (rule) => rule.rule.type === "unique" && Array.isArray(rule.rule.columns) && rule.rule.columns.length === 1,
    );
    return {
      name: column.name,
      type: column.inferred_type,
      description: definition?.kind === "definition" ? definition.text : undefined,
      classification: classification?.kind === "classification" ? classification.sensitivity : undefined,
      required: required || undefined,
      unique: unique || undefined,
      quality: own.length ? own.map(ruleEntry) : undefined,
    };
  });

  const primary = relationships.find(([item]) => item.relationshipKind === "candidate_key");
  const alternates = relationships.filter(([item]) => item.relationshipKind === "composite_key");
  const crossRules = rules.filter((rule) => rule.item.source === "relationship_pass");

  return {
    contract: {
      id: bundle.dataset.id,
      title: bundle.dataset.title,
      version: "0.1.0",
      status: counts.pending === 0 && counts.approved > 0 ? "reviewed" : "draft",
      source: bundle.dataset.name,
      profiled_as_of: bundle.profile.as_of,
      rows: bundle.profile.row_count,
      review: {
        approved: counts.approved,
        rejected: counts.rejected,
        pending: counts.pending,
        reviewed_by: state.audit.length ? state.audit[state.audit.length - 1].actor : null,
        last_decision_at: lastDecision,
      },
    },
    keys:
      primary || alternates.length
        ? {
            primary_key: primary ? primary[0].columns : undefined,
            alternate_keys: alternates.length ? alternates.map(([item]) => item.columns) : undefined,
          }
        : undefined,
    schema,
    relationships: relationships.length
      ? relationships.map(([item, decision]) => ({
          kind: item.relationshipKind ?? "dependent_field",
          columns: item.columns,
          description: decision.value.kind === "relationship" ? decision.value.description : "",
        }))
      : undefined,
    cross_column_quality: crossRules.length ? crossRules.map(ruleEntry) : undefined,
  };
}

export function contractYaml(ctx: ExportContext): string {
  const counts = countItems(ctx.state, ctx.items);
  return toYaml(buildContract(ctx), [
    `Data contract for ${ctx.bundle.dataset.name}`,
    "Generated by Steward from reviewer-approved suggestions only.",
    counts.pending
      ? `${counts.pending} suggestion${counts.pending === 1 ? " is" : "s are"} still pending review and not included.`
      : "No suggestions are pending.",
  ]);
}

/** Abbreviations that read wrong in title case. Anything else is capitalized as a word. */
const ACRONYMS = new Set(
  "id ssn dob ein tin ltv dti upb mi fico apr arm url ip uuid sku usd utc".split(" "),
);

/** A glossary term from a column name: `borrower_ssn` becomes `Borrower SSN`. */
export function glossaryTerm(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

export const GLOSSARY_HEADER = [
  "term",
  "column",
  "definition",
  "classification",
  "data_type",
  "approved_by",
  "approved_at",
];

/** One row per column whose definition was approved. */
export function glossaryRows(ctx: ExportContext): string[][] {
  const classes = new Map(approved(ctx, "classification").map(([item, d]) => [item.column, d.value]));
  return approved(ctx, "definition").map(([item, decision]) => {
    const column = ctx.bundle.profile.columns.find((c) => c.name === item.column);
    const classification = classes.get(item.column);
    const approval = lastApproval(ctx.state.audit, item.id);
    return [
      glossaryTerm(item.column ?? ""),
      item.column ?? "",
      decision.value.kind === "definition" ? decision.value.text : "",
      classification?.kind === "classification" ? classification.sensitivity : "",
      column?.inferred_type ?? "",
      approval?.actor ?? "",
      approval?.at ?? "",
    ];
  });
}

export function glossaryCsv(ctx: ExportContext): string {
  return toCsv(GLOSSARY_HEADER, glossaryRows(ctx));
}

export interface QualitySummary {
  rules: ApprovedRule[];
  ran: number;
  passing: number;
  failing: number;
  notRun: number;
  rowsChecked: number;
  rowsFailed: number;
}

/** Approved rules, worst first: failing by failed rows, then passing, then not yet run. */
export function qualitySummary(ctx: ExportContext): QualitySummary {
  const rank = (rule: ApprovedRule) => (rule.result ? (rule.result.failed > 0 ? 0 : 1) : 2);
  // Array.prototype.sort is stable, so ties keep the order of the review queue.
  const rules = approvedRules(ctx).sort(
    (a, b) => rank(a) - rank(b) || (b.result?.failed ?? 0) - (a.result?.failed ?? 0),
  );
  const ran = rules.filter((rule) => rule.result);
  return {
    rules,
    ran: ran.length,
    passing: ran.filter((rule) => rule.result?.failed === 0).length,
    failing: ran.filter((rule) => (rule.result?.failed ?? 0) > 0).length,
    notRun: rules.length - ran.length,
    rowsChecked: ran.reduce((sum, rule) => sum + (rule.result?.evaluated ?? 0), 0),
    rowsFailed: ran.reduce((sum, rule) => sum + (rule.result?.failed ?? 0), 0),
  };
}

const cell = (value: string | null) =>
  value === null ? "*(empty)*" : value.replaceAll("|", "\\|").replace(/\s*[\r\n]+\s*/g, " ");

export function qualityReportMarkdown(ctx: ExportContext): string {
  const { bundle } = ctx;
  const summary = qualitySummary(ctx);
  const lines = [
    `# Data quality report: ${bundle.dataset.name}`,
    "",
    `As of ${bundle.profile.as_of}. ${formatInt(bundle.profile.row_count)} rows, ${bundle.profile.column_count} columns.`,
    "",
    "Only rules a reviewer approved are listed. Counts come from the Steward rules engine (DuckDB); nothing here was written by a model.",
    "",
    "## Summary",
    "",
    `- Approved rules: ${summary.rules.length}`,
    `- Passing: ${summary.passing}`,
    `- Failing: ${summary.failing}`,
    ...(summary.notRun ? [`- Not run since they were edited: ${summary.notRun}`] : []),
    `- Checks made: ${formatInt(summary.rowsChecked)}, of which ${formatInt(summary.rowsFailed)} failed`,
    "",
  ];
  if (summary.rules.length === 0) {
    lines.push("No rules have been approved yet.", "");
    return lines.join("\n");
  }
  lines.push(
    "## Rules",
    "",
    "| Status | Severity | Rule | Rows checked | Rows failed | Pass rate |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  );
  for (const rule of summary.rules) {
    const result = rule.result;
    lines.push(
      [
        "",
        result ? (result.failed ? "FAIL" : "PASS") : "NOT RUN",
        rule.severity,
        cell(describeRule(rule.rule)),
        result ? formatInt(result.evaluated) : "",
        result ? formatInt(result.failed) : "",
        result && result.pass_rate !== null ? formatPct(result.pass_rate, 2) : "",
        "",
      ]
        .join(" | ")
        .trim(),
    );
  }
  const failing = summary.rules.filter((rule) => rule.result && rule.result.failed > 0);
  if (failing.length) lines.push("", "## Failing rows (samples)");
  for (const rule of failing) {
    const result = rule.result as RuleResult;
    lines.push(
      "",
      `### ${describeRule(rule.rule)}`,
      "",
      `Rule \`${rule.id}\`, severity ${rule.severity}. ${formatInt(result.failed)} of ${formatInt(result.evaluated)} rows fail.`,
      "",
      `| row | ${result.sample_columns.map(cell).join(" | ")} |`,
      `| ---: | ${result.sample_columns.map(() => "---").join(" | ")} |`,
      ...result.samples.map(
        (sample) =>
          `| ${sample.row} | ${result.sample_columns.map((name) => cell(sample.values[name] ?? null)).join(" | ")} |`,
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export { relationshipLabel };
