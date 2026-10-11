#!/usr/bin/env node
/**
 * Records real Claude runs for every preset in fixtures/presets.json.
 *
 *   pnpm record                 # all presets, stops at a $2 budget
 *   pnpm record --budget 0.50   # tighter cap
 *   pnpm record --only tessell  # presets whose route or demoId contains the text
 *
 * Starts the dev server with RECORD_FIXTURES=1 and ALLOW_SERVER_KEY=1 so each
 * API route calls Claude with your key and writes its response into
 * fixtures/<store>.json, replacing the placeholder with the same key.
 * The key is read from the shell, .env.local, or ../.env and never printed.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const budget = Number(flag("--budget") ?? 2);
const port = Number(flag("--port") ?? 3111);
const only = flag("--only");

for (const file of [".env.local", "../.env"]) {
  if (!process.env.ANTHROPIC_API_KEY && existsSync(file)) process.loadEnvFile(file);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to ../.env or .env.local, then re-run.");
  process.exit(1);
}

const presets = JSON.parse(readFileSync("fixtures/presets.json", "utf8")).filter(
  (p) => !only || p.route.includes(only) || String(p.body?.demoId ?? "").includes(only),
);
if (presets.length === 0) {
  console.error("No presets matched.");
  process.exit(1);
}

const base = `http://localhost:${port}`;
const server = spawn("pnpm", ["exec", "next", "dev", "-p", String(port)], {
  env: { ...process.env, RECORD_FIXTURES: "1", ALLOW_SERVER_KEY: "1" },
  stdio: "ignore",
  detached: true,
});
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Dev server did not start.");
}

function lastFrame(text) {
  const chunks = text.split("\n\n").filter((c) => c.startsWith("data: "));
  return chunks.length ? JSON.parse(chunks.at(-1).slice(6)) : null;
}

await waitForServer();
let spent = 0;
let failed = 0;
for (const preset of presets) {
  const name = `${preset.route} ${preset.body?.demoId ?? ""}`.trim();
  if (spent >= budget) {
    console.error(`Budget of $${budget.toFixed(2)} reached. Stopping before: ${name}`);
    failed += 1;
    break;
  }
  const res = await fetch(base + preset.route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preset.body),
  });
  let ok, meta, message;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const frame = lastFrame(await res.text());
    ok = frame?.type === "done";
    meta = frame?.meta;
    message = frame?.error?.message;
  } else {
    const json = await res.json();
    ({ ok, meta } = json);
    message = json.error?.message;
  }
  spent += meta?.costUsd ?? 0;
  if (ok && meta?.mode === "live") {
    console.log(`recorded  ${name}  $${(meta.costUsd ?? 0).toFixed(4)}  ${meta.model}`);
  } else {
    failed += 1;
    console.error(`FAILED    ${name}  ${message ?? `HTTP ${res.status}`}`);
  }
}
console.log(`\nTotal spent: $${spent.toFixed(4)} across ${presets.length} preset(s). Failures: ${failed}.`);
process.exit(failed ? 1 : 0);
