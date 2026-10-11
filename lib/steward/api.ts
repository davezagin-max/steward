/**
 * Browser calls to the Steward API (FastAPI + DuckDB).
 *
 * The app is fully usable without it: the bundled sample needs no network at all. The
 * API is only for the live path, which is profiling your own CSV, running edited rules,
 * and asking Claude for suggestions. Set `NEXT_PUBLIC_API_URL` to turn that path on.
 */
import type { ApiResponse } from "@/lib/api";
import { callApi, streamApi } from "@/lib/client";
import type { AssessEvent, AssessmentRun, Bundle, Profile, Rule, RuleResult } from "./types";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_ROWS = 50_000;
export const MAX_UPLOAD_COLUMNS = 80;

/** The API origin, or null when this deployment runs without it. */
export function apiBase(): string | null {
  const raw = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** What the API needs to find the rows: the bundled sample by name, or the uploaded text. */
export type DataSource = { dataset: "sample" } | { csv: string; name: string };

export interface ProfileData {
  profile: Profile;
  model_view: Bundle["model_view"];
  key_columns: string[];
}

export function profileSource(base: string, source: DataSource): Promise<ApiResponse<ProfileData>> {
  return callApi<ProfileData>(`${base}/api/profile`, source, null);
}

export function runRules(
  base: string,
  source: DataSource,
  rules: Rule[],
  options: { asOf: string; contextColumns: string[] },
): Promise<ApiResponse<{ as_of: string; results: RuleResult[] }>> {
  return callApi(
    `${base}/api/rules/run`,
    { ...source, rules, as_of: options.asOf, context_columns: options.contextColumns },
    null,
  );
}

/**
 * Starts the two Claude passes. The sample is assessed from the server's own profile of
 * it; an upload sends its profile only. Rows never go to this endpoint.
 */
export function streamAssessment(
  base: string,
  target: { dataset: "sample" } | { profile: Profile },
  apiKey: string,
  onEvent: (event: AssessEvent) => void,
  signal?: AbortSignal,
): Promise<ApiResponse<AssessmentRun>> {
  return streamApi<AssessmentRun, AssessEvent>(`${base}/api/assess`, target, apiKey, { onEvent }, signal);
}
