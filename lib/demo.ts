/**
 * Demo mode: replay recorded Claude runs when no API key is present.
 *
 * A fixture is keyed by the request that produced it. Preset requests carry a
 * stable `demoId`; anything else is keyed by a hash of the request body, so an
 * identical request always replays the same recording.
 *
 * Isomorphic on purpose (Web Crypto only) so the same key function runs in
 * route handlers, tests, and the browser.
 */
import type { Usage } from "./config";

export interface Fixture<D = unknown, E = unknown> {
  label: string;
  /**
   * True for a hand-written sample that stands in until a real run is recorded.
   * The UI must say so instead of claiming it is a recorded model run.
   */
  placeholder: boolean;
  recordedAt: string | null;
  model: string;
  usage: Usage;
  costUsd: number;
  data: D;
  /** For streaming routes: the events in order, with ms offsets from the start. */
  events?: { at: number; event: E }[];
}

export type FixtureStore<D = unknown, E = unknown> = Record<string, Fixture<D, E>>;

/** JSON.stringify with sorted object keys, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export async function hashRequest(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

const DEMO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `demoId` when the body has a valid one, otherwise a hash of the whole body. */
export async function requestKey(body: unknown): Promise<string> {
  if (body && typeof body === "object" && "demoId" in body) {
    const id = (body as { demoId?: unknown }).demoId;
    if (typeof id === "string" && DEMO_ID.test(id)) return id;
  }
  return hashRequest(body);
}

export function findFixture<D, E>(store: FixtureStore<D, E>, key: string): Fixture<D, E> | null {
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
}
