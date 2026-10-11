import { describe, expect, it } from "vitest";
import {
  buildItems,
  countItems,
  highConfidencePending,
  initialState,
  reduce,
  restoreState,
  type ItemValue,
} from "@/lib/steward/review";
import { ruleColumns, validateRule } from "@/lib/steward/rules";
import type { Rule } from "@/lib/steward/types";
import { apply, bundle, columns, idsOf, items } from "./helpers";

const NOW = "2026-10-11T15:00:00.000Z";

describe("buildItems", () => {
  it("turns every suggestion in the run into one pending item", () => {
    const run = bundle.run!;
    const ruleCount = new Set([
      ...run.assessments.flatMap((a) => a.rules.map((r) => r.id)),
      ...run.relationships.flatMap((r) => r.rules.map((rule) => rule.id)),
    ]).size;
    expect(items.filter((item) => item.kind === "definition")).toHaveLength(run.assessments.length);
    expect(items.filter((item) => item.kind === "classification")).toHaveLength(run.assessments.length);
    expect(items.filter((item) => item.kind === "rule")).toHaveLength(ruleCount);
    expect(items.filter((item) => item.kind === "relationship")).toHaveLength(run.relationships.length);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    const state = initialState(items);
    expect(countItems(state, items)).toEqual({ total: items.length, pending: items.length, approved: 0, rejected: 0 });
    expect(buildItems(null, () => [])).toEqual([]);
  });

  it("files cross-column rules under their relationship, with every column they read", () => {
    const cross = items.filter((item) => item.kind === "rule" && item.source === "relationship_pass");
    expect(cross.length).toBeGreaterThan(0);
    for (const item of cross) {
      expect(item.column).toBeNull();
      expect(item.relationshipId).toMatch(/^rel_/);
      expect(item.columns.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("reduce", () => {
  it("approves, rejects, and reopens, logging before and after each time", () => {
    const [first, second] = items;
    const state = apply([
      { type: "approve", ids: [first.id] },
      { type: "reject", ids: [second.id] },
      { type: "reopen", ids: [first.id] },
    ]);
    expect(state.decisions[first.id].status).toBe("pending");
    expect(state.decisions[second.id].status).toBe("rejected");
    expect(state.audit.map((entry) => [entry.seq, entry.action, entry.itemId, entry.before.status, entry.after.status])).toEqual([
      [1, "approve", first.id, "pending", "approved"],
      [2, "reject", second.id, "pending", "rejected"],
      [3, "reopen", first.id, "approved", "pending"],
    ]);
    expect(state.audit[0]).toMatchObject({ actor: "reviewer", at: "2026-10-11T15:00:00.000Z", batch: null });
    expect(state.audit[0].label).toBe(`Definition of ${first.column}`);
  });

  it("does nothing, and logs nothing, when an action changes nothing", () => {
    const start = apply([{ type: "approve", ids: [items[0].id] }]);
    expect(reduce(start, { type: "approve", ids: [items[0].id] }, items, NOW)).toBe(start);
    expect(reduce(start, { type: "reject", ids: ["no-such-item"] }, items, NOW)).toBe(start);
    const unchanged: ItemValue = start.decisions[items[0].id].value;
    expect(reduce(start, { type: "edit", id: items[0].id, value: unchanged, approve: true }, items, NOW)).toBe(start);
  });

  it("bulk approve writes one entry per item under one batch id and skips decided items", () => {
    const rejected = idsOf((item) => item.kind === "rule").slice(0, 2);
    const before = apply([{ type: "reject", ids: rejected }]);
    const ids = highConfidencePending(before, items);
    expect(ids.length).toBeGreaterThan(20);
    expect(ids).not.toContain(rejected[0]);
    const after = reduce(before, { type: "approve", ids }, items, NOW);
    const entries = after.audit.slice(before.audit.length);
    expect(entries).toHaveLength(ids.length);
    expect(new Set(entries.map((entry) => entry.batch)).size).toBe(1);
    expect(entries[0].batch).toMatch(/^batch-/);
    expect(countItems(after, items).approved).toBe(ids.length);
    expect(highConfidencePending(after, items)).toEqual([]);
    expect(after.decisions[rejected[0]].status).toBe("rejected");
  });

  it("an edit records the old and new value and sends an approved item back to pending", () => {
    const item = items.find((candidate) => candidate.kind === "classification" && candidate.column === "fico_score")!;
    const edited: ItemValue = { kind: "classification", sensitivity: "Restricted" };
    const state = apply([
      { type: "approve", ids: [item.id] },
      { type: "edit", id: item.id, value: edited, approve: false },
    ]);
    expect(state.decisions[item.id]).toEqual({ status: "pending", value: edited, edited: true });
    const entry = state.audit.at(-1)!;
    expect(entry.action).toBe("edit");
    expect(entry.before).toEqual({ status: "approved", value: item.proposed });
    expect(entry.after).toEqual({ status: "pending", value: edited });
  });

  it("save-and-approve writes an edit entry and then an approve entry", () => {
    const item = items.find((candidate) => candidate.kind === "rule" && candidate.proposed.kind === "rule" && candidate.proposed.rule.type === "range")!;
    const proposed = item.proposed as Extract<ItemValue, { kind: "rule" }>;
    const value: ItemValue = { kind: "rule", severity: "warning", rule: { ...proposed.rule, max: 123456 } };
    const state = apply([{ type: "edit", id: item.id, value, approve: true }]);
    expect(state.audit.map((entry) => entry.action)).toEqual(["edit", "approve"]);
    expect(state.decisions[item.id]).toEqual({ status: "approved", value, edited: true });
    expect(state.audit[1].label).toContain("123,456");
    // Editing back to the proposal clears the edited flag.
    const reverted = reduce(state, { type: "edit", id: item.id, value: item.proposed, approve: false }, items, NOW);
    expect(reverted.decisions[item.id].edited).toBe(false);
  });

  it("refuses an edit whose value is the wrong kind for the item", () => {
    const start = initialState(items);
    const definition = items[0];
    const wrong: ItemValue = { kind: "classification", sensitivity: "Public" };
    expect(reduce(start, { type: "edit", id: definition.id, value: wrong, approve: true }, items, NOW)).toBe(start);
  });

  it("reset returns every item to pending with an empty log", () => {
    const state = apply([{ type: "approve", ids: items.map((item) => item.id) }, { type: "reset" }]);
    expect(state).toEqual(initialState(items));
  });
});

describe("restoreState", () => {
  const isValidRule = (rule: Rule) => validateRule(rule, columns, bundle.catalog).ok;

  it("round-trips a saved review through JSON", () => {
    const state = apply([
      { type: "approve", ids: highConfidencePending(initialState(items), items) },
      { type: "reject", ids: [items[0].id] },
    ]);
    const restored = restoreState(JSON.parse(JSON.stringify(state)), items, isValidRule);
    expect(restored).toEqual(state);
  });

  it("drops anything from storage that does not fit the current suggestions", () => {
    const rule = items.find((item) => item.kind === "rule")!;
    const saved = {
      decisions: {
        "def:not_a_column": { status: "approved", value: { kind: "definition", text: "x" } },
        [items[0].id]: { status: "published", value: items[0].proposed },
        [items[1].id]: { status: "approved", value: { kind: "definition", text: "wrong kind" } },
        [rule.id]: { status: "approved", value: { kind: "rule", severity: "error", rule: { type: "not_null", column: "x; DROP" } } },
        [items[2].id]: { status: "rejected", value: items[2].proposed },
      },
      audit: [{ itemId: "def:not_a_column", at: NOW, label: "x", before: {}, after: {} }, "junk"],
    };
    const classification = items.find((item) => item.kind === "classification" && item.id !== items[1].id)!;
    const secondRule = items.filter((item) => item.kind === "rule")[1];
    Object.assign(saved.decisions, {
      [classification.id]: { status: "approved", value: { kind: "classification", sensitivity: "Top Secret" } },
      [secondRule.id]: { status: "approved", value: { ...secondRule.proposed, severity: "fatal" } },
    });
    const restored = restoreState(saved, items, isValidRule)!;
    expect(countItems(restored, items)).toMatchObject({ approved: 0, rejected: 1 });
    expect(restored.decisions[classification.id]).toEqual({ status: "pending", value: classification.proposed, edited: false });
    expect(restored.decisions["def:not_a_column"]).toBeUndefined();
    expect(restored.audit).toEqual([]);
    expect(restoreState("nonsense", items, isValidRule)).toBeNull();
    expect(restoreState({ decisions: {} }, items, isValidRule)).toBeNull();
  });
});

it("ruleColumns is what links a rule to the columns it shows under", () => {
  const derived = items.find((item) => item.proposed.kind === "rule" && item.proposed.rule.type === "derived_ratio")!;
  expect(derived.columns).toEqual(ruleColumns((derived.proposed as { rule: Rule }).rule, bundle.catalog));
});
