import { describe, expect, it } from "vitest";
import { resultFor } from "@/lib/steward/exports";
import {
  buildItems,
  countItems,
  highConfidencePending,
  initialState,
  nextPending,
  reduce,
  restoreState,
  reviewOrder,
  type ItemValue,
  type ReviewItem,
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

describe("reviewOrder and nextPending", () => {
  const failedOf = (item: ReviewItem) =>
    item.proposed.kind === "rule" ? (resultFor(bundle.results, item.id, item.proposed.rule)?.failed ?? 0) : 0;
  const order = reviewOrder(items, columns, failedOf);

  it("lists every item once, column by column as the workbench shows them", () => {
    expect(order).toHaveLength(items.length);
    expect(new Set(order.map((item) => item.id)).size).toBe(items.length);
    // The first column: its description, its sensitivity label, then its rules, worst first.
    const first = columns[0];
    const own = order.filter((item) => item.column === first);
    expect(order.slice(0, own.length)).toEqual(own);
    expect(own.slice(0, 2).map((item) => item.id)).toEqual([`def:${first}`, `cls:${first}`]);
    const fails = own.slice(2).map(failedOf);
    expect(fails[0]).toBe(28);
    expect(fails).toEqual([...fails].sort((a, b) => b - a));
    // Columns keep file order; cross-column items come last, each relationship before its rules.
    const columnOrder = [...new Set(order.filter((item) => item.column !== null).map((item) => item.column))];
    expect(columnOrder).toEqual(columns.filter((name) => items.some((item) => item.column === name)));
    const firstCross = order.findIndex((item) => item.column === null);
    expect(order.slice(firstCross).every((item) => item.column === null)).toBe(true);
    expect(order[firstCross].kind).toBe("relationship");
    for (const [index, item] of order.entries()) {
      if (item.kind !== "rule" || item.column !== null) continue;
      const owner = order.findIndex((entry) => entry.kind === "relationship" && entry.relationshipId === item.relationshipId);
      expect(owner).toBeGreaterThanOrEqual(firstCross);
      expect(owner).toBeLessThan(index);
    }
  });

  it("walks the pending items in that order, skipping decided ones and wrapping around", () => {
    const start = initialState(items);
    expect(nextPending(order, start, null)?.id).toBe(order[0].id);
    expect(nextPending(order, start, "not-an-item")?.id).toBe(order[0].id);
    // Skipping moves on without deciding anything.
    expect(nextPending(order, start, order[0].id)?.id).toBe(order[1].id);
    // Decided items are passed over.
    const decided = apply([
      { type: "approve", ids: [order[1].id] },
      { type: "reject", ids: [order[2].id] },
    ]);
    expect(nextPending(order, decided, order[0].id)?.id).toBe(order[3].id);
    // From the last item it wraps to the first pending one.
    expect(nextPending(order, decided, order[order.length - 1].id)?.id).toBe(order[0].id);
    // With one item left it returns that item even when asked to skip it.
    const allButOne = apply([{ type: "approve", ids: order.slice(1).map((item) => item.id) }]);
    expect(nextPending(order, allButOne, order[0].id)?.id).toBe(order[0].id);
    const done = apply([{ type: "approve", ids: order.map((item) => item.id) }]);
    expect(nextPending(order, done, null)).toBeNull();
  });
});
