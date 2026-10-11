/**
 * Browser-side view of the rule DSL.
 *
 * The Python service owns the DSL: `server/app/rules.py` defines the catalog, validates
 * rules, and is the only thing that compiles them to SQL. The catalog travels to the
 * browser as data, and everything here is driven by it: the edit forms, this validator,
 * and the plain-English descriptions. The validator exists so a reviewer gets immediate
 * feedback and so an edited rule is well-formed before it is saved; the service validates
 * again before anything runs.
 */
import { stableStringify } from "@/lib/demo";
import { formatNumber } from "./format";
import type { FieldSpec, Rule, RuleTypeSpec } from "./types";

export const MAX_TEXT = 200;
export const MAX_SET_VALUE = 100;
export const MAX_SET_VALUES = 200;
export const MAX_UNIQUE_COLUMNS = 4;

export type Validation = { ok: true; rule: Rule } | { ok: false; error: string };

const fail = (error: string): Validation => ({ ok: false, error });

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** RE2 has no lookaround or backreferences; catch those here instead of after a round trip. */
function regexProblem(pattern: string): string | null {
  if (/\(\?<?[=!]/.test(pattern)) return "RE2 does not support lookahead or lookbehind.";
  if (/\\[1-9]/.test(pattern)) return "RE2 does not support backreferences.";
  try {
    new RegExp(pattern);
  } catch {
    return "The pattern is not a valid regular expression.";
  }
  return null;
}

function checkField(spec: FieldSpec, value: unknown, columns: string[]): string | null {
  const name = spec.label;
  switch (spec.kind) {
    case "column":
      if (typeof value !== "string" || !columns.includes(value)) return `${name}: pick a column.`;
      return null;
    case "columns": {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UNIQUE_COLUMNS) {
        return `${name}: choose 1 to ${MAX_UNIQUE_COLUMNS} columns.`;
      }
      if (!value.every((item) => typeof item === "string" && columns.includes(item))) {
        return `${name}: unknown column.`;
      }
      if (new Set(value).size !== value.length) return `${name}: a column is repeated.`;
      return null;
    }
    case "number":
      return isNumber(value) ? null : `${name}: enter a number.`;
    case "optional_number":
      return value === null || isNumber(value) ? null : `${name}: enter a number or leave it empty.`;
    case "text":
      if (typeof value !== "string" || value.length === 0) return `${name}: required.`;
      if (value.length > MAX_TEXT) return `${name}: at most ${MAX_TEXT} characters.`;
      return null;
    case "text_list": {
      if (!Array.isArray(value) || value.length < 1) return `${name}: add at least one value.`;
      if (value.length > MAX_SET_VALUES) return `${name}: at most ${MAX_SET_VALUES} values.`;
      if (!value.every((item) => typeof item === "string" && item.length > 0)) {
        return `${name}: values cannot be empty.`;
      }
      if (value.some((item) => (item as string).length > MAX_SET_VALUE)) {
        return `${name}: each value can be at most ${MAX_SET_VALUE} characters.`;
      }
      if (new Set(value).size !== value.length) return `${name}: a value is repeated.`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${name}: choose yes or no.`;
    case "choice":
      return typeof value === "string" && spec.choices.includes(value)
        ? null
        : `${name}: choose one of ${spec.choices.join(", ")}.`;
  }
}

function textOf(rule: Rule, key: string): string {
  const value = rule[key];
  return typeof value === "string" ? value : "";
}

function textsOf(rule: Rule, key: string): string[] {
  const value = rule[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOf(rule: Rule, key: string): number | null {
  const value = rule[key];
  return isNumber(value) ? value : null;
}

function distinct(rule: Rule, fields: string[]): boolean {
  const names = fields.map((field) => rule[field]);
  return new Set(names).size === names.length;
}

/** Checks a rule against the catalog and the dataset's columns; returns it in canonical field order. */
export function validateRule(raw: unknown, columns: string[], catalog: RuleTypeSpec[]): Validation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("A rule must be an object.");
  const input = raw as Record<string, unknown>;
  const spec = catalog.find((entry) => entry.type === input.type);
  if (!spec) return fail(`Unknown rule type "${String(input.type).slice(0, 40)}".`);
  const allowed = new Set(["type", ...spec.fields.map((field) => field.name)]);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) return fail(`Unexpected field: ${extra.join(", ").slice(0, 80)}.`);

  const rule: Rule = { type: spec.type };
  for (const field of spec.fields) {
    const value = input[field.name] ?? (field.kind === "optional_number" ? null : undefined);
    const problem = checkField(field, value, columns);
    if (problem) return fail(problem);
    rule[field.name] = value;
  }

  switch (spec.type) {
    case "range": {
      const min = numberOf(rule, "min");
      const max = numberOf(rule, "max");
      if (min === null && max === null) return fail("A range needs a minimum, a maximum, or both.");
      if (min !== null && max !== null && min > max) return fail("The minimum is greater than the maximum.");
      break;
    }
    case "regex": {
      const problem = regexProblem(textOf(rule, "pattern"));
      if (problem) return fail(problem);
      break;
    }
    case "date_order":
      if (!distinct(rule, ["before_column", "after_column"])) return fail("Pick two different columns.");
      break;
    case "conditional_not_null":
      if (!distinct(rule, ["column", "when_column"])) return fail("Pick two different columns.");
      break;
    case "reference_consistency":
      if (!distinct(rule, ["key_column", "dependent_column"])) return fail("Pick two different columns.");
      break;
    case "derived_ratio":
      if (!distinct(rule, ["column", "numerator_column", "denominator_column"])) {
        return fail("Pick three different columns.");
      }
      if (rule.multiplier === 0) return fail("The multiplier cannot be zero.");
      if ((numberOf(rule, "tolerance") ?? 0) < 0) return fail("The tolerance cannot be negative.");
      break;
  }
  return { ok: true, rule };
}

/** Columns a rule reads, in catalog field order. */
export function ruleColumns(rule: Rule, catalog: RuleTypeSpec[]): string[] {
  const spec = catalog.find((entry) => entry.type === rule.type);
  const names: string[] = [];
  for (const field of spec?.fields ?? []) {
    const value = rule[field.name];
    if (field.kind === "column" && typeof value === "string") names.push(value);
    if (field.kind === "columns" && Array.isArray(value)) names.push(...(value as string[]));
  }
  return [...new Set(names)];
}

export function sameRule(a: Rule, b: Rule): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function ruleLabel(rule: Rule, catalog: RuleTypeSpec[]): string {
  return catalog.find((entry) => entry.type === rule.type)?.label ?? rule.type;
}

function list(values: string[], limit = 6): string {
  const shown = values.slice(0, limit).map((value) => (value.trim() === value ? value : `"${value}"`));
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** One plain sentence for a rule. Used in the UI, the contract, and the quality report. */
export function describeRule(rule: Rule): string {
  const t = (key: string) => textOf(rule, key);
  switch (rule.type) {
    case "not_null":
      return `${t("column")} is never empty`;
    case "unique": {
      const columns = textsOf(rule, "columns");
      return columns.length === 1
        ? `${columns[0]} is unique`
        : `The combination of ${columns.join(" + ")} is unique`;
    }
    case "in_set":
      return `${t("column")} is one of: ${list(textsOf(rule, "values"))}`;
    case "range": {
      const min = numberOf(rule, "min");
      const max = numberOf(rule, "max");
      if (min !== null && max !== null) {
        return `${t("column")} is between ${formatNumber(min)} and ${formatNumber(max)}`;
      }
      return min !== null
        ? `${t("column")} is at least ${formatNumber(min)}`
        : `${t("column")} is at most ${formatNumber(max ?? 0)}`;
    }
    case "regex":
      return `${t("column")} matches ${t("pattern")}`;
    case "parses_as":
      return `${t("column")} is a valid ${t("as_type") === "date" ? "ISO date" : t("as_type")}`;
    case "date_not_future":
      return `${t("column")} is not after the as-of date`;
    case "date_order":
      return `${t("before_column")} is ${rule.allow_equal === true ? "on or before" : "before"} ${t("after_column")}`;
    case "conditional_not_null":
      return `${t("column")} is filled when ${t("when_column")} is ${list(textsOf(rule, "when_values")).replace(/, ([^,]*)$/, " or $1")}`;
    case "reference_consistency":
      return `Each ${t("key_column")} always has the same ${t("dependent_column")}`;
    case "derived_ratio": {
      const multiplier = numberOf(rule, "multiplier") ?? 1;
      const scale = multiplier === 1 ? "" : ` x ${formatNumber(multiplier)}`;
      return `${t("column")} equals ${t("numerator_column")} / ${t("denominator_column")}${scale}, within ${formatNumber(numberOf(rule, "tolerance") ?? 0)}`;
    }
    default:
      return `${rule.type} rule`;
  }
}

/** A starting rule of the given type for the edit form. */
export function emptyRule(spec: RuleTypeSpec, column: string | null): Rule {
  const rule: Rule = { type: spec.type };
  let usedColumn = false;
  for (const field of spec.fields) {
    switch (field.kind) {
      case "column":
        rule[field.name] = !usedColumn && column ? column : "";
        usedColumn = true;
        break;
      case "columns":
        rule[field.name] = column ? [column] : [];
        break;
      case "number":
        rule[field.name] = field.name === "multiplier" ? 1 : 0;
        break;
      case "optional_number":
        rule[field.name] = null;
        break;
      case "text":
        rule[field.name] = "";
        break;
      case "text_list":
        rule[field.name] = [];
        break;
      case "boolean":
        rule[field.name] = false;
        break;
      case "choice":
        rule[field.name] = field.choices[0] ?? "";
        break;
    }
  }
  return rule;
}
