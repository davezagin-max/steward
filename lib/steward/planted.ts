/**
 * The answer key for the bundled sample.
 *
 * The generator writes down every problem it plants and the rule that catches it. This
 * matches each planted problem to a rule in the current review, so the UI can show how
 * many of them the suggestions actually caught.
 *
 * A rule matches a planted problem when it is the generator's own rule, or failing that,
 * a rule of the same type over the same columns. Among several such rules, the one whose
 * failure count is closest to the planted count wins. The fallback matters once a real
 * model run replaces the sample suggestions: a model may write `[0-9]{5}` where the
 * generator's rule says `\d{5}`, and that is the same check.
 */
import { resultFor } from "./exports";
import { decisionOf, type Decision, type ReviewItem, type ReviewState } from "./review";
import { ruleColumns } from "./rules";
import type { PlantedIssue, RuleResult, RuleTypeSpec } from "./types";

export interface PlantedMatch {
  issue: PlantedIssue;
  /** The reviewer's decision on the matching rule, or null when no rule covers the problem. */
  decision: Decision | null;
  /** Rows the matching rule fails, or null when there is no rule or it has not run. */
  found: number | null;
  /** True when the rule fails exactly the rows that were planted. */
  caught: boolean;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

export function matchPlanted(
  planted: PlantedIssue[],
  items: ReviewItem[],
  review: ReviewState,
  results: Record<string, RuleResult>,
  catalog: RuleTypeSpec[],
): PlantedMatch[] {
  const rules = items.flatMap((item) => {
    const decision = decisionOf(review, item);
    if (decision.value.kind !== "rule") return [];
    const rule = decision.value.rule;
    return [{ item, decision, rule, failed: resultFor(results, item.id, rule)?.failed ?? null }];
  });
  return planted.map((issue) => {
    const exact = rules.find((entry) => entry.item.id === `rule:${issue.rule_id}`);
    const alike = rules
      .filter((entry) => entry.rule.type === issue.rule_type && sameSet(ruleColumns(entry.rule, catalog), issue.columns))
      .sort((a, b) => distance(a.failed, issue.count) - distance(b.failed, issue.count));
    const match = exact ?? alike[0] ?? null;
    return {
      issue,
      decision: match?.decision ?? null,
      found: match?.failed ?? null,
      caught: match?.failed === issue.count,
    };
  });
}

/** How far a rule's failure count is from the planted count; a rule that has not run sorts last. */
function distance(failed: number | null, planted: number): number {
  return failed === null ? Number.POSITIVE_INFINITY : Math.abs(failed - planted);
}
