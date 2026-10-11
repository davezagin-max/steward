/**
 * Shapes shared with the Python service. `server/app/profiler.py`, `rules.py`, and
 * `assess.py` are the source of truth; `fixtures/demo.json` is produced from them.
 */
import type { ApiMeta } from "@/lib/api";

export type InferredType = "integer" | "decimal" | "date" | "string";
export type Role = "identifier" | "category" | "measure" | "date" | "text";
export type Sensitivity = "Public" | "Internal" | "Confidential" | "Restricted";
export type Confidence = "high" | "medium" | "low";
export type Severity = "error" | "warning";

export const SENSITIVITIES: Sensitivity[] = ["Public", "Internal", "Confidential", "Restricted"];
export const SEVERITIES: Severity[] = ["error", "warning"];

export interface ValueCount {
  value: string;
  count: number;
}

export interface ShapeCount {
  shape: string;
  count: number;
  pct: number;
  regex: string;
}

export interface Histogram {
  kind: "numeric" | "date";
  bins: { lo: number; hi: number; count: number }[];
  below: number;
  above: number;
}

export interface ColumnProfile {
  name: string;
  source_name: string;
  position: number;
  inferred_type: InferredType;
  role: Role;
  row_count: number;
  null_count: number;
  null_pct: number;
  distinct_count: number;
  distinct_pct: number;
  type_conformance: number;
  invalid_count: number;
  invalid_shapes: ShapeCount[];
  whitespace_count: number;
  leading_zero_count: number;
  length: { min: number; max: number } | null;
  numeric: {
    min: number;
    max: number;
    mean: number;
    stddev: number | null;
    p25: number;
    median: number;
    p75: number;
    zeros: number;
    negatives: number;
  } | null;
  dates: { min: string; max: string; future_count: number } | null;
  top_values: ValueCount[];
  shapes: ShapeCount[];
  shape_count: number;
  named_patterns: { name: string; pct: number }[];
  outliers: {
    method: string;
    lower_fence: number;
    upper_fence: number;
    below: number;
    above: number;
    examples: string[];
  } | null;
  histogram: Histogram | null;
  sensitive: boolean;
  sensitive_reasons: string[];
}

export interface KeyCandidate {
  columns: string[];
  exact: boolean;
  uniqueness: number;
  duplicate_rows: number;
  duplicate_groups: number;
  expected_collisions: number | null;
}

export interface FunctionalDependency {
  determinant: string;
  dependent: string;
  rows: number;
  groups: number;
  violations: number;
  holds_pct: number;
}

export interface DateOrdering {
  before: string;
  after: string;
  rows: number;
  equal: number;
  violations: number;
  holds_pct: number;
}

export interface Profile {
  dataset: string;
  as_of: string;
  row_count: number;
  column_count: number;
  duplicate_rows: number;
  columns: ColumnProfile[];
  candidate_keys: KeyCandidate[];
  functional_dependencies: FunctionalDependency[];
  date_orderings: DateOrdering[];
}

/** A rule in the DSL: a `type` plus that type's fields. See `lib/steward/rules.ts`. */
export type Rule = { type: string } & Record<string, unknown>;

export type FieldKind =
  | "column"
  | "columns"
  | "number"
  | "optional_number"
  | "text"
  | "text_list"
  | "boolean"
  | "choice";

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  label: string;
  help: string;
  choices: string[];
}

export interface RuleTypeSpec {
  type: string;
  label: string;
  summary: string;
  scope: "column" | "cross_column";
  fields: FieldSpec[];
}

export interface ProposedRule {
  id: string;
  rule: Rule;
  severity: Severity;
  reason: string;
}

export interface RejectedRule {
  rule: unknown;
  reason: string;
}

export interface ColumnAssessment {
  column: string;
  business_definition: string;
  sensitivity: Sensitivity;
  confidence: Confidence;
  rationale: string;
  rules: ProposedRule[];
  rejected_rules: RejectedRule[];
}

export type RelationshipKind =
  | "candidate_key"
  | "composite_key"
  | "date_ordering"
  | "code_description_pair"
  | "dependent_field"
  | "derived_field";

export interface Relationship {
  id: string;
  kind: RelationshipKind;
  columns: string[];
  description: string;
  confidence: Confidence;
  rationale: string;
  rules: ProposedRule[];
  rejected_rules: RejectedRule[];
}

export interface PassSummary {
  name: "columns" | "relationships";
  effort: string;
  calls: number;
  retries: number;
  usage: ApiMeta["usage"];
  cost_usd: number;
}

export interface AssessmentRun {
  assessments: ColumnAssessment[];
  relationships: Relationship[];
  failures: { column: string | null; reason: string }[];
  passes: PassSummary[];
}

export interface RuleResult {
  rule_id: string;
  rule: Rule;
  status: "pass" | "fail" | "error";
  evaluated: number;
  failed: number;
  passed: number;
  pass_rate: number | null;
  sample_columns: string[];
  samples: { row: number; values: Record<string, string | null> }[];
  sql: string | null;
  params: Record<string, unknown>;
  error: string | null;
}

export interface PlantedIssue {
  id: string;
  kind: string;
  columns: string[];
  description: string;
  count: number;
  /** Id and type of the rule the generator's manifest pairs with this problem. */
  rule_id: string;
  rule_type: string;
  suggested: boolean;
}

export interface DatasetInfo {
  id: string;
  name: string;
  title: string;
  as_of: string;
  key_columns: string[];
  synthetic: boolean;
}

/** Everything the workbench shows for one dataset. */
export interface Bundle {
  /** Usage and provenance of the suggestions; null while a dataset has none. */
  meta: ApiMeta | null;
  dataset: DatasetInfo;
  profile: Profile;
  model_view: { columns: Record<string, unknown>[] } & Record<string, unknown>;
  run: AssessmentRun | null;
  results: Record<string, RuleResult>;
  catalog: RuleTypeSpec[];
  planted: PlantedIssue[];
}

/** Events streamed by `POST /api/assess`. */
export type AssessEvent =
  | { type: "started"; total: number }
  | { type: "column"; assessment: ColumnAssessment; done: number; total: number }
  | { type: "column_failed"; column: string; reason: string; done: number; total: number }
  | { type: "relationships"; relationships: Relationship[] }
  | { type: "pass"; summary: PassSummary };
