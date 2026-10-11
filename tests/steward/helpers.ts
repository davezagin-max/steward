import snapshot from "./fixtures/placeholder-bundle.json";
import type { ExportContext } from "@/lib/steward/exports";
import { buildItems, initialState, reduce, type ReviewAction, type ReviewState } from "@/lib/steward/review";
import { ruleColumns } from "@/lib/steward/rules";
import type { Bundle, Rule } from "@/lib/steward/types";

/**
 * A frozen copy of the hand-written sample bundle. Logic tests assert exact values against
 * it, so they do not change when `pnpm record` replaces the live bundle with a real run.
 * `fixtures.test.ts` checks the live bundle separately.
 */
export const bundle = snapshot as unknown as Bundle;
export const columns = bundle.profile.columns.map((column) => column.name);
export const items = buildItems(bundle.run, (rule: Rule) => ruleColumns(rule, bundle.catalog));

/** Applies actions one second apart, starting at a fixed time. */
export function apply(actions: ReviewAction[], start: ReviewState = initialState(items)): ReviewState {
  return actions.reduce(
    (state, action, index) =>
      reduce(state, action, items, new Date(Date.UTC(2026, 9, 11, 15, 0, index)).toISOString()),
    start,
  );
}

export function context(state: ReviewState): ExportContext {
  return { bundle, items, state, results: bundle.results };
}

export const idsOf = (predicate: (item: (typeof items)[number]) => boolean) =>
  items.filter(predicate).map((item) => item.id);
