/**
 * The live bundle (`fixtures/demo.json`) is what a visitor sees first. Whatever produced
 * it, hand-written placeholders or a recorded run, it has to be internally consistent and
 * pass the same validators the UI uses.
 */
import { describe, expect, it } from "vitest";
import presets from "@/fixtures/presets.json";
import { DEMO_BUNDLE } from "@/lib/steward/bundle";
import { resultFor } from "@/lib/steward/exports";
import { buildItems } from "@/lib/steward/review";
import { describeRule, ruleColumns, validateRule } from "@/lib/steward/rules";
import { SENSITIVITIES, type Rule } from "@/lib/steward/types";
import { bundle as snapshot } from "./helpers";

const live = DEMO_BUNDLE;
const columns = live.profile.columns.map((column) => column.name);
const items = buildItems(live.run, (rule: Rule) => ruleColumns(rule, live.catalog));

describe("live demo bundle", () => {
  it("assesses every column of the profile, in order", () => {
    expect(live.run).not.toBeNull();
    expect(live.run!.assessments.map((a) => a.column)).toEqual(columns);
    for (const assessment of live.run!.assessments) {
      expect(SENSITIVITIES).toContain(assessment.sensitivity);
      expect(["high", "medium", "low"]).toContain(assessment.confidence);
      expect(assessment.business_definition.length).toBeGreaterThan(10);
    }
  });

  it("every suggested rule passes the browser validator and has an engine result for that exact rule", () => {
    const rules = items.filter((item) => item.kind === "rule");
    expect(rules.length).toBeGreaterThanOrEqual(25);
    for (const item of rules) {
      const value = item.proposed as { rule: Rule };
      expect(validateRule(value.rule, columns, live.catalog)).toEqual({ ok: true, rule: value.rule });
      const result = resultFor(live.results, item.id, value.rule);
      expect(result, describeRule(value.rule)).not.toBeNull();
      expect(result!.passed + result!.failed).toBe(result!.evaluated);
      expect(result!.samples.length).toBe(Math.min(result!.failed, 5));
      expect(result!.sql).toContain('"');
    }
    expect(Object.keys(live.results).sort()).toEqual(rules.map((item) => item.id.replace("rule:", "")).sort());
  });

  it("relationships only name real columns", () => {
    for (const relationship of live.run!.relationships) {
      expect(relationship.columns.every((name) => columns.includes(name))).toBe(true);
    }
  });

  it("the masked model view holds no raw values for sensitive columns", () => {
    const sensitive = live.profile.columns.filter((column) => column.sensitive).map((column) => column.name);
    expect(sensitive).toContain("borrower_ssn");
    for (const view of live.model_view.columns) {
      if (!sensitive.includes(view.name as string)) continue;
      expect(view.values_masked).toBe(true);
      expect(view).not.toHaveProperty("values");
      expect(view).not.toHaveProperty("numeric");
    }
  });

  it("is honest about where the suggestions came from", () => {
    const meta = live.meta!;
    if (meta.placeholder) {
      expect(meta).toMatchObject({ mode: "demo", recordedAt: null, costUsd: 0 });
      // While the suggestions are placeholders, the test snapshot is the same bundle.
      expect(snapshot).toEqual(live);
    } else {
      expect(meta.recordedAt).toBeTruthy();
      expect(meta.costUsd).toBeGreaterThan(0);
    }
  });

  it("presets.json lists the preset that `pnpm record` re-runs", () => {
    expect(presets).toEqual([{ route: "/api/assess", body: { demoId: live.dataset.id, dataset: "sample" } }]);
  });
});
