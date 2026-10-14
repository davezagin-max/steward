/**
 * The review queue as a pure state machine.
 *
 * Every suggestion from a run becomes a `ReviewItem`: a column's definition, its
 * sensitivity class, each proposed rule, and each cross-column relationship. Items start
 * as pending. A reviewer approves, edits, rejects, or reopens them, and every change of
 * status or content appends one entry to the audit log with the value before and after.
 * Exports read only approved items.
 *
 * `reduce` has no side effects and takes the clock as an argument, so the whole review
 * workflow is unit-tested without a browser.
 */
import { describeRule, sameRule } from "./rules";
import {
  SENSITIVITIES,
  SEVERITIES,
  type AssessmentRun,
  type Confidence,
  type RelationshipKind,
  type Rule,
  type Sensitivity,
  type Severity,
} from "./types";

export type ItemKind = "definition" | "classification" | "rule" | "relationship";
export type Status = "pending" | "approved" | "rejected";

export type ItemValue =
  | { kind: "definition"; text: string }
  | { kind: "classification"; sensitivity: Sensitivity }
  | { kind: "rule"; rule: Rule; severity: Severity }
  | { kind: "relationship"; description: string };

export interface ReviewItem {
  id: string;
  kind: ItemKind;
  /** The column this item is listed under. Null for cross-column items. */
  column: string | null;
  /** Every column the item touches. */
  columns: string[];
  source: "column_pass" | "relationship_pass";
  relationshipId: string | null;
  relationshipKind: RelationshipKind | null;
  confidence: Confidence;
  rationale: string;
  proposed: ItemValue;
}

export interface Decision {
  status: Status;
  value: ItemValue;
  edited: boolean;
}

export type AuditAction = "approve" | "reject" | "edit" | "reopen";

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: AuditAction;
  itemId: string;
  label: string;
  before: { status: Status; value: ItemValue };
  after: { status: Status; value: ItemValue };
  /** Shared by every entry written by one bulk action. */
  batch: string | null;
}

export interface ReviewState {
  decisions: Record<string, Decision>;
  audit: AuditEntry[];
}

export type ReviewAction =
  | { type: "approve"; ids: string[] }
  | { type: "reject"; ids: string[] }
  | { type: "reopen"; ids: string[] }
  | { type: "edit"; id: string; value: ItemValue; approve: boolean }
  | { type: "restore"; state: ReviewState }
  | { type: "reset" };

export const REVIEWER = "reviewer";

const RELATIONSHIP_LABELS: Record<RelationshipKind, string> = {
  candidate_key: "Key",
  composite_key: "Composite key",
  date_ordering: "Date order",
  code_description_pair: "Code and description",
  dependent_field: "Dependent field",
  derived_field: "Derived field",
};

export function relationshipLabel(kind: RelationshipKind): string {
  return RELATIONSHIP_LABELS[kind] ?? kind;
}

/** Flattens a run into review items, in column order and then relationship order. */
export function buildItems(run: AssessmentRun | null, ruleColumnsOf: (rule: Rule) => string[]): ReviewItem[] {
  if (!run) return [];
  const items: ReviewItem[] = [];
  const seen = new Set<string>();
  for (const assessment of run.assessments) {
    const base = {
      column: assessment.column,
      source: "column_pass" as const,
      relationshipId: null,
      relationshipKind: null,
      confidence: assessment.confidence,
    };
    items.push({
      ...base,
      id: `def:${assessment.column}`,
      kind: "definition",
      columns: [assessment.column],
      rationale: assessment.rationale,
      proposed: { kind: "definition", text: assessment.business_definition },
    });
    items.push({
      ...base,
      id: `cls:${assessment.column}`,
      kind: "classification",
      columns: [assessment.column],
      rationale: assessment.rationale,
      proposed: { kind: "classification", sensitivity: assessment.sensitivity },
    });
    for (const proposed of assessment.rules) {
      if (seen.has(proposed.id)) continue;
      seen.add(proposed.id);
      items.push({
        ...base,
        id: `rule:${proposed.id}`,
        kind: "rule",
        columns: ruleColumnsOf(proposed.rule),
        rationale: proposed.reason,
        proposed: { kind: "rule", rule: proposed.rule, severity: proposed.severity },
      });
    }
  }
  for (const relationship of run.relationships) {
    const base = {
      column: null,
      source: "relationship_pass" as const,
      relationshipId: relationship.id,
      relationshipKind: relationship.kind,
      confidence: relationship.confidence,
    };
    items.push({
      ...base,
      id: `rel:${relationship.id}`,
      kind: "relationship",
      columns: relationship.columns,
      rationale: relationship.rationale,
      proposed: { kind: "relationship", description: relationship.description },
    });
    for (const proposed of relationship.rules) {
      if (seen.has(proposed.id)) continue;
      seen.add(proposed.id);
      items.push({
        ...base,
        id: `rule:${proposed.id}`,
        kind: "rule",
        columns: ruleColumnsOf(proposed.rule),
        rationale: proposed.reason,
        proposed: { kind: "rule", rule: proposed.rule, severity: proposed.severity },
      });
    }
  }
  return items;
}

export function initialState(items: ReviewItem[]): ReviewState {
  return {
    decisions: Object.fromEntries(
      items.map((item) => [item.id, { status: "pending", value: item.proposed, edited: false }]),
    ),
    audit: [],
  };
}

/** An item's decision. Items the state has not seen yet (a run still streaming in) are pending. */
export function decisionOf(state: ReviewState, item: ReviewItem): Decision {
  return state.decisions[item.id] ?? { status: "pending", value: item.proposed, edited: false };
}

export function sameValue(a: ItemValue, b: ItemValue): boolean {
  if (a.kind === "definition" && b.kind === "definition") return a.text === b.text;
  if (a.kind === "classification" && b.kind === "classification") return a.sensitivity === b.sensitivity;
  if (a.kind === "relationship" && b.kind === "relationship") return a.description === b.description;
  if (a.kind === "rule" && b.kind === "rule") return a.severity === b.severity && sameRule(a.rule, b.rule);
  return false;
}

export function valueSummary(value: ItemValue): string {
  switch (value.kind) {
    case "definition":
      return value.text;
    case "classification":
      return value.sensitivity;
    case "relationship":
      return value.description;
    case "rule":
      return `${describeRule(value.rule)} (${value.severity})`;
  }
}

export function itemLabel(item: ReviewItem, value: ItemValue = item.proposed): string {
  switch (item.kind) {
    case "definition":
      return `Definition of ${item.column}`;
    case "classification":
      return `Classification of ${item.column}`;
    case "relationship":
      return `${relationshipLabel(item.relationshipKind ?? "dependent_field")}: ${item.columns.join(", ")}`;
    case "rule":
      return value.kind === "rule" ? `Rule: ${describeRule(value.rule)}` : "Rule";
  }
}

const TARGET: Record<"approve" | "reject" | "reopen", Status> = {
  approve: "approved",
  reject: "rejected",
  reopen: "pending",
};

/**
 * Applies one reviewer action. Returns the same state object when nothing changes, so a
 * repeated click never adds a duplicate audit entry.
 */
export function reduce(
  state: ReviewState,
  action: ReviewAction,
  items: ReviewItem[],
  now: string,
  actor: string = REVIEWER,
): ReviewState {
  if (action.type === "reset") return initialState(items);
  if (action.type === "restore") return action.state;

  const byId = new Map(items.map((item) => [item.id, item]));
  const decisions = { ...state.decisions };
  const audit = [...state.audit];
  const log = (
    kind: AuditAction,
    item: ReviewItem,
    before: Decision,
    after: Decision,
    batch: string | null,
  ) => {
    audit.push({
      seq: audit.length + 1,
      at: now,
      actor,
      action: kind,
      itemId: item.id,
      label: itemLabel(item, after.value),
      before: { status: before.status, value: before.value },
      after: { status: after.status, value: after.value },
      batch,
    });
  };

  if (action.type === "edit") {
    const item = byId.get(action.id);
    if (!item || action.value.kind !== item.proposed.kind) return state;
    const before = decisionOf(state, item);
    let current = before;
    if (!sameValue(before.value, action.value)) {
      // Changed content needs a fresh decision, whatever the status was.
      current = {
        status: "pending",
        value: action.value,
        edited: !sameValue(action.value, item.proposed),
      };
      log("edit", item, before, current, null);
    }
    if (action.approve && current.status !== "approved") {
      const approved = { ...current, status: "approved" as const };
      log("approve", item, current, approved, null);
      current = approved;
    }
    if (current === before) return state;
    decisions[action.id] = current;
    return { decisions, audit };
  }

  const target = TARGET[action.type];
  const changing = [...new Set(action.ids)]
    .map((id) => byId.get(id))
    .filter((item): item is ReviewItem => !!item && decisionOf(state, item).status !== target);
  if (changing.length === 0) return state;
  const batch = changing.length > 1 ? `batch-${audit.length + 1}` : null;
  for (const item of changing) {
    const before = decisionOf(state, item);
    const after = { ...before, status: target };
    decisions[item.id] = after;
    log(action.type, item, before, after, batch);
  }
  return { decisions, audit };
}

export interface Counts {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

export function countItems(state: ReviewState, items: ReviewItem[]): Counts {
  const counts: Counts = { total: items.length, pending: 0, approved: 0, rejected: 0 };
  for (const item of items) counts[decisionOf(state, item).status] += 1;
  return counts;
}

/** Pending items the model was confident about: the default bulk-approve set. */
export function highConfidencePending(state: ReviewState, items: ReviewItem[]): string[] {
  return items
    .filter((item) => item.confidence === "high" && decisionOf(state, item).status === "pending")
    .map((item) => item.id);
}

const KIND_RANK: Record<ItemKind, number> = { definition: 0, classification: 1, rule: 2, relationship: 3 };

/**
 * Items in the order the workbench shows them: column by column in file order (the
 * description, the sensitivity label, then the rules with the most failing rows first),
 * then each cross-column relationship followed by its own rules. "Start reviewing" walks
 * this order.
 */
export function reviewOrder(items: ReviewItem[], columns: string[], failedOf: (item: ReviewItem) => number): ReviewItem[] {
  const ordered: ReviewItem[] = [];
  for (const name of columns) {
    const own = items.filter((item) => item.column === name);
    own.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.kind === "rule" ? failedOf(b) - failedOf(a) : 0));
    ordered.push(...own);
  }
  for (const relationship of items.filter((item) => item.kind === "relationship")) {
    ordered.push(relationship);
    ordered.push(...items.filter((item) => item.kind === "rule" && item.column === null && item.relationshipId === relationship.relationshipId));
  }
  const placed = new Set(ordered.map((item) => item.id));
  return [...ordered, ...items.filter((item) => !placed.has(item.id))];
}

/**
 * The first pending item after `afterId` in `order`, wrapping around to the start. With
 * no `afterId` (or an unknown one) it is the first pending item. Null when nothing is pending.
 */
export function nextPending(order: ReviewItem[], state: ReviewState, afterId: string | null): ReviewItem | null {
  const start = afterId === null ? -1 : order.findIndex((item) => item.id === afterId);
  for (let step = 1; step <= order.length; step++) {
    const item = order[(start + step) % order.length];
    if (decisionOf(state, item).status === "pending") return item;
  }
  return null;
}

/**
 * Rebuilds a saved review from untrusted storage. Anything that does not match the
 * current items (unknown ids, wrong value kinds, bad statuses) is dropped, and the saved
 * state is ignored entirely unless it was made for the same set of suggestions.
 */
export function restoreState(
  saved: unknown,
  items: ReviewItem[],
  isValidRule: (rule: Rule) => boolean,
): ReviewState | null {
  if (!saved || typeof saved !== "object") return null;
  const { decisions, audit } = saved as { decisions?: unknown; audit?: unknown };
  if (!decisions || typeof decisions !== "object" || !Array.isArray(audit)) return null;
  const fresh = initialState(items);
  const statuses = new Set<Status>(["pending", "approved", "rejected"]);
  for (const item of items) {
    const candidate = (decisions as Record<string, Partial<Decision> | undefined>)[item.id];
    if (!candidate || !statuses.has(candidate.status as Status)) continue;
    const value = candidate.value;
    if (!value || value.kind !== item.proposed.kind) continue;
    if (value.kind === "rule" && !(isValidRule(value.rule) && SEVERITIES.includes(value.severity))) continue;
    if (value.kind === "classification" && !SENSITIVITIES.includes(value.sensitivity)) continue;
    if (value.kind === "definition" && typeof value.text !== "string") continue;
    if (value.kind === "relationship" && typeof value.description !== "string") continue;
    fresh.decisions[item.id] = {
      status: candidate.status as Status,
      value,
      edited: !sameValue(value, item.proposed),
    };
  }
  const known = new Set(items.map((item) => item.id));
  fresh.audit = (audit as AuditEntry[])
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        known.has(entry.itemId) &&
        typeof entry.at === "string" &&
        typeof entry.label === "string" &&
        entry.before?.value &&
        entry.after?.value,
    )
    .map((entry, index) => ({ ...entry, seq: index + 1 }));
  return fresh;
}
