import { describe, expect, it } from "vitest";
import { describeRule, emptyRule, ruleColumns, sameRule, validateRule } from "@/lib/steward/rules";
import type { Rule } from "@/lib/steward/types";
import { bundle, columns } from "./helpers";

const catalog = bundle.catalog;
const check = (raw: unknown) => validateRule(raw, columns, catalog);
const error = (raw: unknown) => {
  const result = check(raw);
  return result.ok ? null : result.error;
};

describe("validateRule", () => {
  it("returns rules in canonical field order and fills an omitted optional bound", () => {
    const result = check({ max: 850, column: "fico_score", type: "range" });
    expect(result).toEqual({
      ok: true,
      rule: { type: "range", column: "fico_score", min: null, max: 850 },
    });
    expect(result.ok && Object.keys(result.rule)).toEqual(["type", "column", "min", "max"]);
  });

  it.each([
    ["DROP TABLE dataset", "A rule must be an object."],
    [{ type: "sql", query: "SELECT 1" }, 'Unknown rule type "sql".'],
    [{ type: "not_null", column: "nope" }, "Column: pick a column."],
    [{ type: "not_null", column: "loan_id", where: "1=1" }, "Unexpected field: where."],
    [{ type: "unique", columns: [] }, "Columns: choose 1 to 4 columns."],
    [{ type: "unique", columns: ["loan_id", "loan_id"] }, "Columns: a column is repeated."],
    [{ type: "in_set", column: "occupancy_code", values: [] }, "Allowed values: add at least one value."],
    [{ type: "in_set", column: "occupancy_code", values: ["P", "P"] }, "Allowed values: a value is repeated."],
    [{ type: "range", column: "ltv", min: null, max: null }, "A range needs a minimum, a maximum, or both."],
    [{ type: "range", column: "ltv", min: 10, max: 1 }, "The minimum is greater than the maximum."],
    [{ type: "range", column: "ltv", min: Number.NaN, max: 1 }, "Minimum: enter a number or leave it empty."],
    [{ type: "regex", column: "loan_id", pattern: "((" }, "The pattern is not a valid regular expression."],
    [{ type: "regex", column: "loan_id", pattern: "(?!x)y" }, "RE2 does not support lookahead or lookbehind."],
    [{ type: "regex", column: "loan_id", pattern: "(a)\\1" }, "RE2 does not support backreferences."],
    [{ type: "parses_as", column: "ltv", as_type: "timestamp" }, "Type: choose one of date, integer, decimal."],
    [
      { type: "date_order", before_column: "borrower_dob", after_column: "borrower_dob", allow_equal: true },
      "Pick two different columns.",
    ],
    [
      { type: "derived_ratio", column: "ltv", numerator_column: "original_upb", denominator_column: "appraised_value", multiplier: 0, tolerance: 0.01 },
      "The multiplier cannot be zero.",
    ],
  ])("rejects %j", (raw, message) => {
    expect(error(raw)).toBe(message);
  });

  it("accepts every rule the Python service put in the bundle, unchanged", () => {
    const rules = Object.values(bundle.results).map((result) => result.rule);
    expect(rules.length).toBeGreaterThan(20);
    for (const rule of rules) {
      const result = check(rule);
      expect(result).toEqual({ ok: true, rule });
    }
  });

  it("agrees with the service about the one suggestion its validator rejected", () => {
    const rejected = (bundle.run?.assessments ?? []).flatMap((a) => a.rejected_rules);
    for (const { rule } of rejected) expect(check(rule).ok).toBe(false);
  });
});

describe("catalog-driven helpers", () => {
  it("covers every rule type in the catalog with a description and an empty form", () => {
    expect(catalog.map((spec) => spec.type)).toEqual([
      "not_null", "unique", "in_set", "range", "regex", "parses_as", "date_not_future",
      "date_order", "conditional_not_null", "reference_consistency", "derived_ratio",
    ]);
    for (const spec of catalog) {
      const blank = emptyRule(spec, "ltv");
      expect(Object.keys(blank)).toEqual(["type", ...spec.fields.map((field) => field.name)]);
      expect(describeRule(blank)).not.toMatch(/ rule$/);
    }
  });

  it("describes rules in plain English", () => {
    const cases: [Rule, string][] = [
      [{ type: "not_null", column: "loan_id" }, "loan_id is never empty"],
      [{ type: "unique", columns: ["loan_id"] }, "loan_id is unique"],
      [
        { type: "unique", columns: ["servicer_id", "servicer_loan_number"] },
        "The combination of servicer_id + servicer_loan_number is unique",
      ],
      [{ type: "in_set", column: "occupancy_code", values: ["P", "S ", "I"] }, 'occupancy_code is one of: P, "S ", I'],
      [{ type: "range", column: "fico_score", min: 300, max: 850 }, "fico_score is between 300 and 850"],
      [{ type: "range", column: "appraised_value", min: 1, max: null }, "appraised_value is at least 1"],
      [{ type: "parses_as", column: "first_payment_date", as_type: "date" }, "first_payment_date is a valid ISO date"],
      [
        { type: "date_order", before_column: "origination_date", after_column: "first_payment_date", allow_equal: false },
        "origination_date is before first_payment_date",
      ],
      [
        { type: "conditional_not_null", column: "mi_coverage_pct", when_column: "mi_type_code", when_values: ["BPMI", "LPMI"] },
        "mi_coverage_pct is filled when mi_type_code is BPMI or LPMI",
      ],
      [
        { type: "derived_ratio", column: "ltv", numerator_column: "original_upb", denominator_column: "appraised_value", multiplier: 100, tolerance: 0.01 },
        "ltv equals original_upb / appraised_value x 100, within 0.01",
      ],
    ];
    for (const [rule, text] of cases) expect(describeRule(rule)).toBe(text);
  });

  it("lists the columns a rule reads and compares rules by content", () => {
    const rule: Rule = { type: "conditional_not_null", column: "mi_coverage_pct", when_column: "mi_type_code", when_values: ["BPMI"] };
    expect(ruleColumns(rule, catalog)).toEqual(["mi_coverage_pct", "mi_type_code"]);
    expect(sameRule({ type: "range", column: "ltv", min: 1, max: 105 }, { max: 105, min: 1, column: "ltv", type: "range" })).toBe(true);
    expect(sameRule({ type: "range", column: "ltv", min: 1, max: 105 }, { type: "range", column: "ltv", min: 1, max: 100 })).toBe(false);
  });
});
