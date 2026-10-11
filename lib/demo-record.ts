/**
 * Fixture recording. Node-only and loaded lazily, so it never reaches a client
 * bundle. Active only when the server runs with `RECORD_FIXTURES=1`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Fixture, FixtureStore } from "./demo";

export function recordingEnabled(): boolean {
  return process.env.RECORD_FIXTURES === "1" && process.env.NODE_ENV !== "production";
}

/** Writes one fixture into `fixtures/<store>.json`, keeping keys sorted for clean diffs. */
export async function saveFixture(store: string, key: string, fixture: Fixture): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(store)) throw new Error(`Invalid fixture store name: ${store}`);
  const file = path.join(process.cwd(), "fixtures", `${store}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  let current: FixtureStore = {};
  try {
    current = JSON.parse(await readFile(file, "utf8")) as FixtureStore;
  } catch {
    // First recording for this store.
  }
  current[key] = fixture;
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(file, `${JSON.stringify(sorted, null, 2)}\n`);
}
