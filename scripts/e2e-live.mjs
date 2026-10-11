#!/usr/bin/env node
/**
 * End-to-end check of the live path, with no Anthropic key.
 *
 *   pnpm e2e:live
 *
 * Starts the Steward API with a scripted stand-in for Claude
 * (server/scripts/scripted_api.py) and the Next dev server pointed at it, then drives a
 * headless browser through: editing a rule and re-running it, a review that survives a
 * reload, uploading a CSV, and a streamed assessment of that upload. Exits non-zero if
 * any step does not behave as expected. Needs `uv` and the Playwright browser.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const WEB = 3130;
const API = 8130;
const procs = [
  spawn("uv", ["run", "uvicorn", "scripts.scripted_api:app", "--port", String(API)], {
    cwd: "server",
    env: { ...process.env, ALLOWED_ORIGINS: `http://localhost:${WEB}` },
    stdio: "ignore",
    detached: true,
  }),
  spawn("pnpm", ["exec", "next", "dev", "-p", String(WEB)], {
    env: { ...process.env, NEXT_PUBLIC_API_URL: `http://localhost:${API}` },
    stdio: "ignore",
    detached: true,
  }),
];
const dir = mkdtempSync(path.join(tmpdir(), "steward-e2e-"));
const stop = () => {
  for (const proc of procs) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

async function ready(url) {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not start`);
}
await ready(`http://localhost:${API}/health`);
await ready(`http://localhost:${WEB}/`);

const rows = ["Order ID,Status,Amount,Created,Shipped,Customer Email"];
for (let i = 1; i <= 240; i++) {
  const status = i % 37 === 0 ? "shipped " : ["new", "paid", "shipped"][i % 3];
  rows.push(
    `${1000 + i},${status},${(i * 7.5).toFixed(2)},2025-0${(i % 9) + 1}-1${i % 9},2025-1${i % 2}-2${i % 9},person${i}@example.com`,
  );
}
const csv = path.join(dir, "orders.csv");
writeFileSync(csv, rows.join("\n") + "\n");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
page.on("pageerror", (error) => errors.push(String(error)));
const progress = () => page.locator("section[aria-label='Dataset and review progress']").innerText();
const step = (name) => console.log(`ok  ${name}`);

try {
  await page.goto(`http://localhost:${WEB}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("h2");

  // An edited rule runs on the sample through the API, with no key.
  await page.click("nav[aria-label='Columns'] >> text=fico_score");
  const original = page.locator("li", { hasText: "fico_score is between 300 and 850" }).first();
  await original.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Minimum").fill("620");
  await page.getByRole("button", { name: "Save as pending" }).click();
  const edited = page.locator("li", { hasText: "fico_score is between 620 and 850" }).first();
  await edited.getByText("Not run since the edit").waitFor();
  await edited.getByRole("button", { name: "Run rule" }).click();
  await edited.getByText(/\d+ fail/).waitFor({ timeout: 15_000 });
  const failed = Number((await edited.getByText(/\d+ fail/).innerText()).replace(/\D/g, ""));
  assert.ok(failed > 9, `a tighter range should fail more than the original 9 rows, got ${failed}`);
  step(`edited rule re-run by the engine (${failed} rows fail)`);

  // The review of the sample survives a reload.
  await page.getByRole("button", { name: /high-confidence/ }).click();
  const before = await progress();
  assert.match(before, /[1-9]\d* approved/);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("h2");
  assert.equal(await progress(), before);
  step("review and audit log restored after reload");

  // Upload a CSV: profiled by the API, headers sanitized, no suggestions yet.
  await page.getByRole("button", { name: /Use your own data/ }).click();
  await page.getByText("Connected to").waitFor();
  await page.setInputFiles("input[type=file]", csv);
  await page.locator("dialog[open]").getByText("your upload", { exact: true }).waitFor({ timeout: 15_000 });
  assert.match(await progress(), /orders\.csv · 240 rows · 6 columns/);
  assert.match(await progress(), /No suggestions yet/);
  await page.locator("nav[aria-label='Columns']").getByText("customer_email").waitFor();
  step("upload profiled");

  // Add a (fake) key and run the streamed assessment against the scripted client.
  await page.locator("dialog[open]").getByRole("button", { name: "Add key" }).click();
  await page.locator("input[name=key]").fill(`sk-ant-${"e2e0".repeat(6)}`);
  await page.locator("input[name=key]").press("Enter");
  await page.getByRole("button", { name: /Run on 6 columns/ }).click();
  await page.getByText(/Assessing columns: \d of 6/).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 30_000 });
  const after = await progress();
  assert.match(after, /12 of 12 suggestions waiting for review|18 of 18 suggestions waiting for review/);
  assert.match(after, /This run:[\s\S]*cached/);
  await page.getByText("order_id is never empty").waitFor();
  await page.getByText("All pass").first().waitFor();
  await page.getByText(/suggested rule blocked by the validator/).waitFor();
  step("streamed assessment, rules run on the upload, cached tokens shown");

  // Back to the sample: its saved review comes back.
  await page.getByRole("button", { name: /Use your own data/ }).click();
  await page.getByRole("button", { name: "Back to the sample" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await progress(), before);
  step("back to the sample with its review intact");

  assert.deepEqual(errors, [], "the browser console should be clean");
  console.log("\nLive path OK.");
} finally {
  await browser.close();
}
process.exit(0);
