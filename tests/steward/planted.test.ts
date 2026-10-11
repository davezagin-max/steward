import { describe, expect, it } from "vitest";
import { matchPlanted } from "@/lib/steward/planted";
import { buildItems, initialState } from "@/lib/steward/review";
import { ruleColumns } from "@/lib/steward/rules";
import type { AssessmentRun, Rule, RuleResult } from "@/lib/steward/types";
import { apply, bundle, items } from "./helpers";

const match = (state = initialState(items), results = bundle.results) =>
  matchPlanted(bundle.planted, items, state, results, bundle.catalog);

describe("answer key for the planted problems", () => {
  it("pairs every planted problem with the rule that fails exactly the planted rows", () => {
    const rows = match();
    expect(rows).toHaveLength(17);
    for (const row of rows) {
      expect(row.caught, row.issue.id).toBe(true);
      expect(row.found).toBe(row.issue.count);
      expect(row.decision?.status).toBe("pending");
    }
    expect(Object.fromEntries(rows.slice(0, 3).map((row) => [row.issue.id, row.found]))).toEqual({
      duplicate_loan_id: 28,
      duplicate_servicer_key: 28,
      origination_date_null: 7,
    });
  });

  it("follows the reviewer's decision and stops counting a rule edited since it last ran", () => {
    const fico = bundle.planted.find((issue) => issue.id === "fico_out_of_range")!;
    const id = `rule:${fico.rule_id}`;
    const rejected = match(apply([{ type: "reject", ids: [id] }])).find((row) => row.issue.id === fico.id)!;
    expect(rejected.decision?.status).toBe("rejected");
    expect(rejected.caught).toBe(true);

    const edited: Rule = { type: "range", column: "fico_score", min: 620, max: 850 };
    const state = apply([{ type: "edit", id, value: { kind: "rule", rule: edited, severity: "error" }, approve: true }]);
    const row = match(state).find((entry) => entry.issue.id === fico.id)!;
    // The stored result belongs to the 300 to 850 version, so it no longer applies.
    expect(row).toMatchObject({ found: null, caught: false });
    expect(row.decision).toMatchObject({ status: "approved", edited: true });
  });

  it("recognizes an equivalent rule from a different run by type and columns", () => {
    // A run that words two checks differently from the generator's manifest: another
    // regex for the SSN format, and a tighter FICO range that fails more rows.
    const ssn: Rule = { type: "regex", column: "borrower_ssn", pattern: "\\d{3}-\\d{2}-\\d{4}" };
    const fico: Rule = { type: "range", column: "fico_score", min: 350, max: 850 };
    const loose: Rule = { type: "range", column: "fico_score", min: 0, max: 100000 };
    const assessment = (column: string, rules: [string, Rule][]) => ({
      column,
      business_definition: "A definition.",
      sensitivity: "Internal" as const,
      confidence: "high" as const,
      rationale: "",
      rules: rules.map(([id, rule]) => ({ id, rule, severity: "error" as const, reason: "" })),
      rejected_rules: [],
    });
    const run: AssessmentRun = {
      assessments: [assessment("borrower_ssn", [["r_ssn", ssn]]), assessment("fico_score", [["r_loose", loose], ["r_fico", fico]])],
      relationships: [],
      failures: [],
      passes: [],
    };
    const result = (rule: Rule, failed: number): RuleResult => ({
      rule_id: "",
      rule,
      status: failed ? "fail" : "pass",
      evaluated: 5014,
      failed,
      passed: 5014 - failed,
      pass_rate: (5014 - failed) / 5014,
      sample_columns: [],
      samples: [],
      sql: null,
      params: {},
      error: null,
    });
    const other = buildItems(run, (rule: Rule) => ruleColumns(rule, bundle.catalog));
    const rows = matchPlanted(
      bundle.planted,
      other,
      initialState(other),
      { r_ssn: result(ssn, 14), r_loose: result(loose, 0), r_fico: result(fico, 11) },
      bundle.catalog,
    );
    const byId = Object.fromEntries(rows.map((row) => [row.issue.id, row]));
    expect(byId.ssn_format).toMatchObject({ found: 14, caught: true });
    // Of the two range rules on fico_score, the one closest to the 9 planted rows is shown,
    // and 11 is reported as it is: close, not exact.
    expect(byId.fico_out_of_range).toMatchObject({ found: 11, caught: false });
    expect(byId.duplicate_loan_id).toMatchObject({ decision: null, found: null, caught: false });
    expect(rows.filter((row) => row.caught)).toHaveLength(1);
  });
});
