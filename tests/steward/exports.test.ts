import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { csvCell, toCsv } from "@/lib/steward/csv";
import {
  approvedRules,
  buildContract,
  contractYaml,
  glossaryCsv,
  glossaryRows,
  qualityReportMarkdown,
  qualitySummary,
  resultFor,
} from "@/lib/steward/exports";
import { initialState, type ItemValue } from "@/lib/steward/review";
import { toYaml, yamlScalar, type Yaml } from "@/lib/steward/yaml";
import { apply, bundle, context, idsOf, items } from "./helpers";

const everything = apply([{ type: "approve", ids: items.map((item) => item.id) }]);

describe("yaml emitter", () => {
  it("quotes anything a YAML parser could misread", () => {
    expect(yamlScalar("Internal")).toBe("Internal");
    expect(yamlScalar("loan_id is unique")).toBe("loan_id is unique");
    for (const tricky of ["true", "No", "null", "~", "12", "2025-09-30", "a: b", "# x", " padded", "", "[x]", "- x", "it's", 'say "hi"', "a\nb", "é", "@x", "*x", "x,y"]) {
      expect(yamlScalar(tricky)).toBe(JSON.stringify(tricky));
    }
    expect(yamlScalar(1.5)).toBe("1.5");
    expect(yamlScalar(null)).toBe("null");
    expect(yamlScalar(Number.NaN)).toBe("null");
  });

  it("round-trips nested data through a real YAML parser", () => {
    const data: Yaml = {
      name: "loans",
      "odd key: here": "value # not a comment",
      count: 5014,
      ratio: 0.9972,
      flag: false,
      nothing: null,
      empty_list: [],
      empty_map: {},
      codes: ["P", "S ", "12", "true", "- dash"],
      long_list: Array.from({ length: 30 }, (_, index) => `value number ${index}`),
      nested: { deep: { deeper: [{ a: 1, b: [{ c: "x: y" }] }, { a: 2, b: [] }] } },
      matrix: [["a", "b"], ["c"]],
      text: "line one\nline two\ttabbed \\ backslash",
    };
    expect(parse(toYaml(data, ["a header", "", "second line"]))).toEqual(data);
    expect(toYaml(data, ["a header"]).startsWith("# a header\nname: loans\n")).toBe(true);
    expect(toYaml({ skipped: undefined, kept: 1 })).toBe("kept: 1\n");
  });
});

describe("csv writer", () => {
  it("quotes per RFC 4180 and defuses spreadsheet formulas", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1 801 555 0100")).toBe("'+1 801 555 0100");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [["1", "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});

describe("data contract", () => {
  it("contains nothing but the schema facts before any approval", () => {
    const contract = parse(contractYaml(context(initialState(items))));
    expect(contract.contract).toMatchObject({ status: "draft", rows: 5014, source: "loans_sample.csv" });
    expect(contract.contract.review).toEqual({
      approved: 0,
      rejected: 0,
      pending: items.length,
      reviewed_by: null,
      last_decision_at: null,
    });
    expect(Object.keys(contract)).toEqual(["contract", "schema"]);
    expect(contract.schema).toHaveLength(25);
    expect(contract.schema[0]).toEqual({ name: "loan_id", type: "string" });
    expect(contractYaml(context(initialState(items)))).toContain(`# ${items.length} suggestions are still pending review`);
  });

  it("includes exactly what was approved, and nothing that was rejected or left pending", () => {
    const state = apply([
      { type: "approve", ids: idsOf((item) => item.column === "loan_id") },
      { type: "approve", ids: idsOf((item) => item.column === "fico_score" && item.kind === "classification") },
      { type: "reject", ids: idsOf((item) => item.column === "fico_score" && item.kind === "definition") },
    ]);
    const contract = parse(contractYaml(context(state)));
    const [loanId] = contract.schema;
    expect(loanId).toMatchObject({ name: "loan_id", classification: "Internal", required: true, unique: true });
    expect(loanId.description).toBe(bundle.run!.assessments[0].business_definition);
    expect(loanId.quality.map((rule: { type: string }) => rule.type)).toEqual(["not_null", "unique", "regex"]);
    expect(loanId.quality[1]).toMatchObject({ severity: "error", description: "loan_id is unique", params: { columns: ["loan_id"] } });
    const fico = contract.schema.find((column: { name: string }) => column.name === "fico_score");
    expect(fico).toEqual({ name: "fico_score", type: "integer", classification: "Confidential" });
    expect(contract.relationships).toBeUndefined();
    expect(contract.contract.review).toMatchObject({ approved: 6, rejected: 1, reviewed_by: "reviewer", last_decision_at: "2026-10-11T15:00:02.000Z" });
  });

  it("uses the reviewer's edited value, not the model's proposal", () => {
    const definition = items.find((item) => item.id === "def:ltv")!;
    const text = 'Loan-to-value: "LTV" = balance / value, in %.\nReviewed by credit risk.';
    const range = items.find((item) => item.column === "ltv" && item.proposed.kind === "rule" && item.proposed.rule.type === "range")!;
    const edited: ItemValue = { kind: "rule", severity: "error", rule: { type: "range", column: "ltv", min: 1, max: 97 } };
    const state = apply([
      { type: "edit", id: definition.id, value: { kind: "definition", text }, approve: true },
      { type: "edit", id: range.id, value: edited, approve: true },
    ]);
    const ltv = parse(contractYaml(context(state))).schema.find((column: { name: string }) => column.name === "ltv");
    expect(ltv.description).toBe(text);
    expect(ltv.quality).toEqual([
      { id: range.id.replace("rule:", ""), type: "range", severity: "error", description: "ltv is between 1 and 97", params: { column: "ltv", min: 1, max: 97 } },
    ]);
  });

  it("is complete and marked reviewed when everything is approved", () => {
    const yaml = contractYaml(context(everything));
    const contract = parse(yaml);
    expect(contract).toEqual(JSON.parse(JSON.stringify(buildContract(context(everything)))));
    expect(contract.contract.status).toBe("reviewed");
    expect(contract.keys).toEqual({ primary_key: ["loan_id"], alternate_keys: [["servicer_id", "servicer_loan_number"]] });
    expect(contract.relationships).toHaveLength(bundle.run!.relationships.length);
    expect(contract.cross_column_quality.map((rule: { type: string }) => rule.type)).toContain("derived_ratio");
    expect(contract.schema.every((column: { description?: string; classification?: string }) => column.description && column.classification)).toBe(true);
    expect(yaml).toContain("# No suggestions are pending.");
    // Deterministic: the same review always produces the same file.
    expect(contractYaml(context(everything))).toBe(yaml);
  });
});

describe("business glossary", () => {
  it("has one row per approved definition, with its approval from the audit log", () => {
    const state = apply([
      { type: "approve", ids: ["def:borrower_ssn", "cls:borrower_ssn", "def:property_zip"] },
      { type: "reject", ids: ["def:loan_id"] },
    ]);
    const rows = glossaryRows(context(state));
    expect(rows).toEqual([
      ["Borrower SSN", "borrower_ssn", bundle.run!.assessments[5].business_definition, "Restricted", "string", "reviewer", "2026-10-11T15:00:00.000Z"],
      ["Property Zip", "property_zip", bundle.run!.assessments[11].business_definition, "", "string", "reviewer", "2026-10-11T15:00:00.000Z"],
    ]);
    const csv = glossaryCsv(context(state));
    expect(csv.split("\r\n")[0]).toBe("term,column,definition,classification,data_type,approved_by,approved_at");
    expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
    expect(glossaryCsv(context(initialState(items))).trim()).toBe("term,column,definition,classification,data_type,approved_by,approved_at");
  });
});

describe("data-quality report", () => {
  it("counts approved rules from the engine's results, worst first", () => {
    const summary = qualitySummary(context(everything));
    const results = Object.values(bundle.results);
    expect(summary.rules).toHaveLength(results.length);
    expect(summary.failing).toBe(results.filter((result) => result.failed > 0).length);
    expect(summary.passing).toBe(results.filter((result) => result.failed === 0).length);
    expect(summary.notRun).toBe(0);
    expect(summary.rowsFailed).toBe(results.reduce((sum, result) => sum + result.failed, 0));
    const failed = summary.rules.map((rule) => rule.result?.failed ?? -1);
    expect(failed.slice(0, summary.failing)).toEqual([...failed.slice(0, summary.failing)].sort((a, b) => b - a));
    expect(failed[0]).toBe(Math.max(...results.map((result) => result.failed)));
  });

  it("lists failing rows only for approved rules and never for pending ones", () => {
    const unique = items.find((item) => item.proposed.kind === "rule" && item.proposed.rule.type === "unique" && item.column === "loan_id")!;
    const report = qualityReportMarkdown(context(apply([{ type: "approve", ids: [unique.id] }])));
    expect(report).toContain("- Approved rules: 1");
    expect(report).toContain("| FAIL | error | loan_id is unique | 5,014 | 28 | 99.44% |");
    expect(report).toContain("### loan_id is unique");
    expect(report).toMatch(/\| row \| loan_id \|\n\| ---: \| --- \|\n\| \d+ \| LN\d{8} \|/);
    expect(report).not.toContain("fico_score");
    expect(qualityReportMarkdown(context(initialState(items)))).toContain("No rules have been approved yet.");
  });

  it("treats a rule edited after its last run as not run", () => {
    const item = items.find((candidate) => candidate.column === "fico_score" && candidate.proposed.kind === "rule" && candidate.proposed.rule.type === "range")!;
    const edited: ItemValue = { kind: "rule", severity: "error", rule: { type: "range", column: "fico_score", min: 620, max: 850 } };
    const state = apply([{ type: "edit", id: item.id, value: edited, approve: true }]);
    const [rule] = approvedRules(context(state));
    expect(rule.result).toBeNull();
    expect(resultFor(bundle.results, item.id, (item.proposed as { rule: typeof edited.rule }).rule)).not.toBeNull();
    const report = qualityReportMarkdown(context(state));
    expect(report).toContain("| NOT RUN | error | fico_score is between 620 and 850 |");
    expect(report).toContain("- Not run since they were edited: 1");
    // A fresh result for the edited rule is picked up.
    const rerun = { ...bundle.results[item.id.replace("rule:", "")], rule: edited.rule, failed: 77, passed: 4787 };
    const ctx = { ...context(state), results: { ...bundle.results, [rerun.rule_id]: rerun } };
    expect(approvedRules(ctx)[0].result?.failed).toBe(77);
  });
});
