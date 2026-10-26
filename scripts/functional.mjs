#!/usr/bin/env node
/**
 * Functional check of every feature in the Steward brief and README, in a headless browser.
 *
 *   pnpm build && pnpm exec next start -p 3130      <- the production server must already be running on port 3130
 *   pnpm functional
 *
 * The app is built once in each of two modes, and this script detects which one is served:
 *   - the demo build (no NEXT_PUBLIC_API_URL): the sample works with no server at all;
 *   - the API build (NEXT_PUBLIC_API_URL=http://localhost:8130): upload, edited-rule re-runs and
 *     the key flow also need the Steward API (`cd server && uv run uvicorn app.main:app --port 8130`).
 * Features that need the other build are reported as not testable in this run.
 *
 * Nothing here calls Claude. No Anthropic key is sent to the API; the key dialog is only given a
 * well-formed fake key, which is never used for a request (the assessment is never started).
 *
 * Every check runs at 1280x800 and 390x844 unless it says otherwise. Each step fails on a console
 * error, an uncaught page error, or a page wider than the viewport. Exits non-zero on any failure.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parse as parseYaml } from "yaml";

const WEB = process.env.STEWARD_WEB ?? "http://localhost:3130";
const API = process.env.STEWARD_API ?? "http://localhost:8130";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_JSON = process.env.FUNCTIONAL_JSON ?? null;

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};
const FAKE_KEY = "sk-ant-functional-test-0000000000000000"; // well-formed, never sent to Anthropic
const GLOSSARY_HEADER = ["term", "column", "definition", "classification", "data_type", "approved_by", "approved_at"];

const bundle = JSON.parse(readFileSync(path.join(ROOT, "fixtures/demo.json"), "utf8"));
const CSV_ORDERS = [
  "Order ID,Status,Amount,Created,Shipped,Customer Email",
  ...Array.from({ length: 240 }, (_, index) => {
    const i = index + 1;
    const status = i % 37 === 0 ? "shipped " : ["new", "paid", "shipped"][i % 3];
    return `${1000 + i},${status},${(i * 7.5).toFixed(2)},2025-0${(i % 9) + 1}-1${i % 9},2025-1${i % 2}-2${i % 9},person${i}@example.com`;
  }),
].join("\n") + "\n";

const norm = (text) => (text ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a truthy value. Throws with the last value if time runs out. */
async function poll(check, description, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${description} (last value: ${String(last).slice(0, 160)})`);
    await sleep(120);
  }
}

// ---------------------------------------------------------------- sessions

async function openSession(browser, vp, { dark = false } = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[vp],
    colorScheme: "light",
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  if (dark) {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("theme", "dark");
      } catch {}
    });
  }
  const page = await context.newPage();
  const session = { vp, page, context, errors: [], apiRequests: [], apiResponses: [], externalRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error") session.errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().startsWith(API)) session.apiResponses.push({ status: response.status(), url: response.url() });
  });
  page.on("pageerror", (error) => session.errors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    if (request.url().startsWith(API)) session.apiRequests.push(`${request.method()} ${request.url()}`);
    else if (!request.url().startsWith(WEB) && !request.url().startsWith("data:")) session.externalRequests.push(request.url());
  });
  await page.goto(`${WEB}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("h2").first().waitFor({ timeout: 20000 });
  // Best effort: the page is ready once its heading shows; networkidle only tidies up late requests.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  return session;
}

/** Every step: no sideways scroll on either viewport, and no console or page errors so far. */
async function settle(s, label) {
  const { scroll, width } = await s.page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  if (scroll > width) throw new Error(`page scrolls sideways after "${label}" (${scroll}px wide in a ${width}px viewport)`);
  // Chromium logs every 4xx answer as "Failed to load resource". The API's own 4xx answers are
  // expected (the app shows their message), so only those are set aside; anything else fails.
  const unexplained = s.errors.filter((text) => {
    const status = Number(text.match(/status of (4\d\d)/)?.[1] ?? 0);
    return !(status && s.apiResponses.some((response) => response.status === status));
  });
  if (unexplained.length) throw new Error(`browser error after "${label}": ${unexplained.join(" | ")}`);
}

// ---------------------------------------------------------------- page helpers

const overview = (s) => s.page.locator("section[aria-labelledby='overview-title']");
const progress = (s) => s.page.locator("section[aria-label='Dataset and review progress']");
const views = (s) => s.page.getByRole("navigation", { name: "Views" });
/** The workbench's own header (it has the product name), not the headers on the cards. */
const topHeader = (s) => s.page.locator("header:has(h1)");
const item = (s, id) => s.page.locator(`[data-review-item="${id}"]`);
const itemWithText = (s, text, prefix = "") =>
  s.page.locator(`[data-review-item^="${prefix}"]`).filter({ hasText: text }).first();
const queueRows = (s) => s.page.locator("ul[aria-label='Suggestions'] > li");
const liveDialog = (s) => s.page.locator("dialog[open]");

async function progressCounts(s) {
  const text = norm(await progress(s).locator("p[aria-live='polite']").first().textContent());
  const match = text.match(/([\d,]+) approved · ([\d,]+) rejected · ([\d,]+) of ([\d,]+) suggestions/);
  assert.ok(match, `progress line not recognised: "${text}"`);
  const n = (value) => Number(value.replace(/,/g, ""));
  return { approved: n(match[1]), rejected: n(match[2]), pending: n(match[3]), total: n(match[4]) };
}

async function viewTitle(s) {
  return norm(await s.page.locator("main h2").nth(1).textContent());
}

async function goTab(s, name) {
  await views(s).getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await poll(
    async () => (await views(s).getByRole("button", { name: new RegExp(`^${name}`) }).getAttribute("aria-current")) === "page",
    `the ${name} tab to be current`,
  );
}

async function pickColumn(s, name) {
  // The column rail belongs to the Columns view, so switch there first.
  await goTab(s, "Columns");
  if (s.vp === "phone") {
    await s.page.locator("select#column-select").selectOption(name);
  } else {
    await s.page
      .locator("nav[aria-label='Columns'] button")
      .filter({ has: s.page.locator("span.font-mono", { hasText: new RegExp(`^${name}$`) }) })
      .first()
      .click();
  }
  await poll(async () => (await viewTitle(s)) === name, `column ${name} to open`);
}

async function pickCrossColumn(s) {
  await goTab(s, "Columns");
  if (s.vp === "phone") await s.page.locator("select#column-select").selectOption("__relationships");
  else await s.page.locator("nav[aria-label='Columns'] button", { hasText: "Cross-column" }).click();
  await poll(async () => (await viewTitle(s)) === "Cross-column relationships", "the cross-column view");
}

async function setQueueStatus(s, label) {
  await s.page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: new RegExp(`^${label}`) }).click();
}

/** Opens the review queue, then sets the status and kind filters. */
async function queue(s, { status = "Pending", kind = "all" } = {}) {
  await goTab(s, "Review queue");
  await setQueueStatus(s, status);
  await s.page.locator("#queue-kind").selectOption(kind);
}

/** Relative brightness (0 to 1) of a computed `rgb(...)` colour. The theme uses hex tokens, so
 *  computed colours are always rgb; anything else is reported rather than guessed at. */
function luminance(rgb) {
  assert.match(rgb, /^rgba?\(/, `expected an rgb colour, got ${rgb}`);
  const [r, g, b] = rgb.match(/[\d.]+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function download(s, trigger) {
  const [file] = await Promise.all([s.page.waitForEvent("download"), trigger()]);
  const saved = await file.path();
  return { name: file.suggestedFilename(), text: readFileSync(saved, "utf8") };
}

/** Counts from the bundled fixture, used to cross-check the numbers the UI prints. */
const fixtureCounts = (() => {
  const assessments = bundle.run.assessments;
  const count = (predicate) => assessments.filter(predicate).length;
  return {
    definitions: assessments.length,
    classifications: assessments.length,
    highDefinitions: count((a) => a.confidence === "high"),
    rejectedRuleColumn: assessments.find((a) => a.rejected_rules.length > 0)?.column ?? null,
    ssnMasked: bundle.profile.columns.find((c) => c.name === "borrower_ssn")?.sensitive === true,
  };
})();

// ---------------------------------------------------------------- features

const FEATURES = [];
function feature(id, name, options, run) {
  FEATURES.push({ id, name, ...options, run });
}

feature("F01", "First screen: what it is, what it shows, what to do first", {}, async (s) => {
  const text = norm(await overview(s).textContent());
  assert.match(text, /Claude drafts the documentation and quality checks for a dataset\. A person approves every suggestion\./);
  assert.match(text, /5,014 rows of fake mortgage loans in 25 columns, with 17 data problems planted for the checks to find\./);
  assert.equal(await overview(s).locator("ol[aria-label='How it works'] > li").count(), 3, "three plain steps");
  for (const step of ["Code profiles the data", "Claude suggests", "A person approves each one"]) {
    assert.ok(text.includes(step), `step "${step}" is shown`);
  }
  const start = overview(s).getByRole("button", { name: "Start reviewing", exact: true });
  const box = await start.boundingBox();
  assert.ok(box, "the Start reviewing button is rendered");
  assert.ok(box.y + box.height <= VIEWPORTS[s.vp].height, `Start reviewing sits above the fold (bottom at ${Math.round(box.y + box.height)}px)`);
  assert.equal(norm(await progress(s).textContent()).includes("116 of 116 suggestions waiting for review"), true, "README count: 116 suggestions");
  await settle(s, "first screen");
});

feature("F02", "Demo banner says the AI output is pre-written, and offers the way to run it live", {}, async (s) => {
  const banner = norm(await s.page.locator("div[role='status']").first().textContent());
  assert.match(banner, /Demo: Claude's suggestions here are pre-written examples/);
  assert.doesNotMatch(banner.toLowerCase(), /error|failed/, "the banner does not read like an error");
  if (s.buildKind === "api") {
    assert.ok(banner.includes("Add your Anthropic API key to run it live."), "API build asks for a key");
    await s.page.locator("div[role='status']").first().getByRole("button", { name: "Add key" }).click();
    await poll(async () => (await s.page.locator("dialog[open] h2").textContent()) === "Add your Anthropic key", "the key dialog");
    await s.page.keyboard.press("Escape");
  } else {
    await s.page.locator("div[role='status']").first().getByRole("button", { name: "How to run it live" }).click();
    await poll(async () => (await s.page.locator("dialog[open] h2").textContent()) === "Use your own data", "the Use your own data dialog");
    await s.page.keyboard.press("Escape");
  }
  await settle(s, "banner");
});

feature("F03", "Header tabs switch between columns, review queue, and exports", {}, async (s) => {
  assert.equal(await viewTitle(s), "loan_id", "the first column opens first");
  await goTab(s, "Review queue");
  assert.equal(await viewTitle(s), "Review queue");
  assert.match(norm(await views(s).getByRole("button", { name: /^Review queue/ }).textContent()), /Review queue\s?116/);
  await settle(s, "queue tab");
  await goTab(s, "Exports");
  assert.equal(await viewTitle(s), "Exports");
  await goTab(s, "Columns");
  assert.equal(await viewTitle(s), "loan_id");
  await settle(s, "columns tab");
});

feature("F04", "Dark theme toggle switches the page and survives a reload", {}, async (s) => {
  const toggle = () => s.page.getByRole("button", { name: /Switch to (dark|light) theme/ });
  await toggle().click();
  await poll(() => s.page.evaluate(() => document.documentElement.dataset.theme === "dark"), "dark theme");
  const bg = await s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.ok(luminance(bg) < 0.25, `dark background expected, got ${bg}`);
  await s.page.reload({ waitUntil: "networkidle" });
  await poll(() => s.page.evaluate(() => document.documentElement.dataset.theme === "dark"), "dark theme after reload");
  await toggle().click();
  await poll(() => s.page.evaluate(() => document.documentElement.dataset.theme === "light"), "light theme");
  await settle(s, "theme toggle");
});

feature("F05", "Key screens render in dark theme", { dark: true }, async (s) => {
  const bg = await s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.ok(luminance(bg) < 0.25, `dark page expected, got ${bg}`);
  const headlineColor = await s.page.evaluate(() => getComputedStyle(document.querySelector("#overview-title")).color);
  assert.ok(luminance(headlineColor) > 0.6, `light text on dark expected, got ${headlineColor}`);
  await settle(s, "dark overview");
  await queue(s);
  await settle(s, "dark queue");
  await pickColumn(s, "fico_score");
  await settle(s, "dark column");
  await goTab(s, "Exports");
  await settle(s, "dark exports");
  await topHeader(s).getByRole("button", { name: /Audit log/ }).click();
  await poll(() => liveDialog(s).count().then((n) => n === 1), "audit drawer");
  const drawerBg = await liveDialog(s).evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.ok(luminance(drawerBg) < 0.25, `dark drawer expected, got ${drawerBg}`);
  await s.page.keyboard.press("Escape");
  await settle(s, "dark audit drawer");
});

feature("F06", "Answer key lists the 17 planted problems and opens their columns", {}, async (s) => {
  const open = async () => s.page.getByRole("button", { name: "17 planted problems" }).click();
  await open();
  await poll(async () => (await s.page.locator("dialog[open] h2").textContent()) === "What is wrong with the sample", "the answer key");
  assert.equal(await s.page.locator("dialog[open] tbody tr").count(), 17, "one row per planted problem");
  await settle(s, "answer key open");
  await s.page.keyboard.press("Escape");
  await poll(async () => (await liveDialog(s).count()) === 0, "answer key closed with Escape");
  await open();
  await s.page.locator("dialog[open] button[aria-label='Close']").click();
  await poll(async () => (await liveDialog(s).count()) === 0, "answer key closed with Close");
  await open();
  await s.page.mouse.click(3, 3);
  await poll(async () => (await liveDialog(s).count()) === 0, "answer key closed by clicking outside it");
  await open();
  await s.page.locator("dialog[open] tbody button").first().click();
  await poll(async () => (await viewTitle(s)) === "loan_id", "the first planted problem's column");
  await settle(s, "answer key row");
});

feature("F07", "Profiler numbers: outliers, near-keys, unparsed dates, leading zeros, empty and distinct counts", {}, async (s) => {
  await pickColumn(s, "interest_rate");
  const profile = norm(await s.page.locator("section", { hasText: "Data profile" }).first().textContent());
  assert.ok(profile.includes("measured by code (DuckDB), not by the AI"), "profile is labelled as measured by code");
  assert.match(profile, /Empty/);
  assert.match(profile, /Distinct/);
  assert.match(profile, /4 outliers beyond Tukey's far fences/, "Tukey far-fence outliers on interest_rate");
  await settle(s, "interest_rate profile");

  await pickColumn(s, "loan_id");
  assert.match(norm(await s.page.locator("section", { hasText: "Data profile" }).first().textContent()), /Key candidate: 99\.72% unique, 14 duplicated values\./);
  await settle(s, "loan_id profile");

  await pickColumn(s, "first_payment_date");
  assert.match(norm(await s.page.locator("section", { hasText: "Data profile" }).first().textContent()), /18 values do not parse as date/, "unparseable first-payment dates counted");
  await settle(s, "first_payment_date profile");

  await pickColumn(s, "property_zip");
  assert.match(norm(await s.page.locator("section", { hasText: "Data profile" }).first().textContent()), /digits starting with zero/, "ZIP codes stay text");
  await settle(s, "property_zip profile");
});

feature("F08", "Cross-column view: measured keys, dependencies, date order, and links into columns", {}, async (s) => {
  await pickCrossColumn(s);
  const text = norm(await s.page.locator("main").textContent());
  assert.ok(text.includes("Candidate keys"), "candidate keys section");
  assert.ok(text.includes("One column determines another"), "dependency section");
  assert.ok(text.includes("Date order"), "date order section");
  assert.match(text, /About \d+ duplicates would be expected if the columns were unrelated\./);
  await settle(s, "cross-column view");
  await s.page.getByRole("button", { name: "property_zip", exact: true }).first().click();
  await poll(async () => (await viewTitle(s)) === "property_zip", "link to property_zip");
  await settle(s, "cross-column link");
});

feature("F09", "Column rail: filter, select, and the phone select", {}, async (s) => {
  if (s.vp === "desktop") {
    const rail = s.page.locator("nav[aria-label='Columns']");
    const columnButtons = () => rail.locator("ul > li").count();
    assert.equal(await columnButtons(), 26, "cross-column entry plus 25 columns");
    await s.page.locator("#column-search").fill("fico");
    await poll(async () => (await columnButtons()) === 2, "filter to fico_score");
    assert.match(norm(await rail.textContent()), /fico_score/);
    await s.page.locator("#column-search").fill("zzzz-no-such");
    await poll(async () => norm(await rail.textContent()).includes("No column matches"), "the no-match message");
    await s.page.locator("#column-search").fill("");
    await poll(async () => (await columnButtons()) === 26, "all columns back");
    await pickColumn(s, "fico_score");
  } else {
    assert.equal(await s.page.locator("select#column-select option").count(), 26, "phone select lists 25 columns plus cross-column");
    await pickColumn(s, "fico_score");
  }
  await settle(s, "rail");
});

feature("F10", "Previous and next column buttons, with the ends disabled", {}, async (s) => {
  await pickColumn(s, "loan_id");
  assert.equal(await s.page.getByRole("button", { name: "Previous column" }).isDisabled(), true, "no column before the first");
  await s.page.getByRole("button", { name: "Next column" }).click();
  await poll(async () => (await viewTitle(s)) === "servicer_id", "next column");
  await s.page.getByRole("button", { name: "Previous column" }).click();
  await poll(async () => (await viewTitle(s)) === "loan_id", "previous column");
  await settle(s, "previous and next");
});

feature("F11", "Suggestion per column: description, sensitivity label, rationale, and confidence", {}, async (s) => {
  await pickColumn(s, "loan_id");
  const definition = norm(await item(s, "def:loan_id").textContent());
  assert.ok(definition.includes("Description"), "the description block is labelled");
  const label = norm(await item(s, "cls:loan_id").textContent());
  assert.ok(label.includes("Sensitivity label"), "the sensitivity label block is labelled");
  assert.ok(/Internal|Public|Confidential|Restricted/.test(label), "a sensitivity class is shown");
  const card = norm(await s.page.locator("section", { hasText: "Suggested by Claude" }).first().textContent());
  assert.ok(card.includes("Why"), "the rationale is shown");
  assert.ok(await s.page.locator("[title^='Model confidence: ']").first().count(), "confidence is shown");
  await settle(s, "suggestion card");
});

feature("F12", "Rules show pass and fail counts from the engine", {}, async (s) => {
  await pickColumn(s, "loan_id");
  const unique = itemWithText(s, "loan_id is unique", "rule:");
  const uniqueText = norm(await unique.textContent());
  assert.match(uniqueText, /28 rows fail/, "28 duplicated loan IDs fail the uniqueness rule");
  assert.match(uniqueText, /99\.44% of 5,014 pass/, "pass rate on the 5,014 rows");
  assert.ok(uniqueText.includes("Rule as data and compiled SQL"), "the rule as data is available");
  await settle(s, "rule counts");
  await s.page.locator("[data-review-item^='rule:']").filter({ hasText: "loan_id is unique" }).first()
    .getByText("Rule as data and compiled SQL").click();
  await poll(async () => (await unique.locator("pre").first().textContent()).includes('"type": "unique"'), "the rule as JSON");
  assert.ok((await unique.locator("pre").last().textContent()).length > 0, "the compiled SQL is shown");
  await settle(s, "rule as data");
});

feature("F13", "Failing rows expand into a sample table with row numbers", {}, async (s) => {
  await pickColumn(s, "loan_id");
  const unique = itemWithText(s, "loan_id is unique", "rule:");
  await unique.getByText(/^Failing rows \(/).click();
  const table = unique.locator("table");
  await table.waitFor();
  assert.ok((await table.locator("caption").textContent()).includes("Sample of rows that fail this rule"));
  assert.ok((await table.locator("thead th").first().textContent()).trim() === "row", "first column is the row number");
  assert.ok((await table.locator("tbody tr").count()) > 0, "at least one failing row is shown");
  await settle(s, "failing rows");
});

feature("F14", "A rule the validator refused is shown, labelled, and never run", {}, async (s) => {
  const column = fixtureCounts.rejectedRuleColumn;
  assert.ok(column, "the fixture has a rule the validator refused");
  await pickColumn(s, column);
  const summary = s.page.getByText(/suggested rule(s)? blocked by the validator/).first();
  await summary.waitFor();
  await summary.click();
  await poll(async () => norm(await s.page.locator("main").textContent()).includes("It never reached the engine."), "the refusal reason");
  await settle(s, "blocked rule");
});

feature("F15", "A masked column shows exactly what Claude is sent, and why it is masked", {}, async (s) => {
  assert.equal(fixtureCounts.ssnMasked, true, "the SSN column is masked in the fixture");
  await pickColumn(s, "borrower_ssn");
  // The heading reads "was shown" once a run exists and "would be shown" before one.
  const details = s.page.locator("details").filter({ hasText: /What Claude (was|would be) shown for this column/ }).first();
  assert.match(norm(await details.textContent()), /every raw value is masked/);
  await details.locator("summary").click();
  await poll(async () => norm(await details.textContent()).includes("Masked because:"), "the masked reason");
  await settle(s, "masked column");
});

feature("F16", "Approve, reject, and reopen a suggestion, with the progress line updating", {}, async (s) => {
  await pickColumn(s, "loan_id");
  await item(s, "def:loan_id").locator("[data-approve]").click();
  await poll(async () => (await progressCounts(s)).approved === 1, "one approval");
  assert.ok(norm(await item(s, "def:loan_id").textContent()).includes("Approved"), "the description shows Approved");
  await item(s, "cls:loan_id").getByRole("button", { name: "Reject", exact: true }).click();
  await poll(async () => (await progressCounts(s)).rejected === 1, "one rejection");
  assert.ok(norm(await item(s, "cls:loan_id").textContent()).includes("Rejected"), "the label shows Rejected");
  await item(s, "cls:loan_id").getByRole("button", { name: "Reopen", exact: true }).click();
  await poll(async () => (await progressCounts(s)).rejected === 0, "the rejection reopened");
  assert.ok(norm(await item(s, "cls:loan_id").textContent()).includes("Pending"), "the label is pending again");
  await settle(s, "approve reject reopen");
});

feature("F17", "Edit a description: refuses a short one, then saves and approves", {}, async (s) => {
  await pickColumn(s, "loan_id");
  const box = item(s, "def:loan_id");
  await box.getByRole("button", { name: "Edit", exact: true }).click();
  await box.locator("textarea").fill("a");
  await box.getByRole("button", { name: "Save and approve" }).click();
  await poll(async () => (await box.locator("[role='alert']").textContent()) === "Write a definition first.", "the short-text error");
  const text = "Unique identifier for each loan on the servicing tape.";
  await box.locator("textarea").fill(text);
  await box.getByRole("button", { name: "Save and approve" }).click();
  await poll(async () => norm(await box.locator("p").first().textContent()) === text, "the new description");
  assert.ok(norm(await box.textContent()).includes("· edited"), "the edited mark shows");
  assert.equal((await progressCounts(s)).approved, 1, "saving and approving counts as an approval");
  await settle(s, "edit description");
});

feature("F18", "Edit a sensitivity label and save it as pending", {}, async (s) => {
  await pickColumn(s, "loan_id");
  const box = item(s, "cls:loan_id");
  await box.getByRole("button", { name: "Edit", exact: true }).click();
  await box.locator("select").selectOption("Restricted");
  await box.getByRole("button", { name: "Save as pending" }).click();
  await poll(async () => norm(await box.textContent()).includes("Restricted"), "the new label");
  assert.ok(norm(await box.textContent()).includes("Pending"), "saved as pending");
  assert.equal((await progressCounts(s)).approved, 0, "a pending save is not an approval");
  await settle(s, "edit label");
});

feature("F19", "Edit a rule's numbers: the edited rule is marked not run, and a bad range is refused", {}, async (s) => {
  await pickColumn(s, "fico_score");
  const rule = itemWithText(s, "fico_score is between 300 and 850", "rule:");
  await rule.getByRole("button", { name: "Edit", exact: true }).click();
  await s.page.getByLabel("Minimum", { exact: true }).fill("620");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  const edited = itemWithText(s, "fico_score is between 620 and 850", "rule:");
  await edited.getByText("Not run since the edit").waitFor();
  if (s.buildKind === "api") {
    await edited.getByRole("button", { name: "Run rule" }).waitFor();
  } else {
    assert.match(norm(await edited.textContent()), /Running an edited rule needs the Steward API, which this demo runs without\./);
  }
  await settle(s, "edited rule");
  await edited.getByRole("button", { name: "Edit", exact: true }).click();
  await s.page.getByLabel("Minimum", { exact: true }).fill("900");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  await poll(async () => norm(await s.page.locator("[role='alert']").first().textContent()) === "The minimum is greater than the maximum.", "the range error");
  await s.page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(await itemWithText(s, "fico_score is between 620 and 850", "rule:").count(), "the refused edit changed nothing");
  await settle(s, "rule range error");
});

feature("F20", "A rule with a non-finite number (1e400) is refused in the form, not read as an empty bound", {}, async (s) => {
  await pickColumn(s, "fico_score");
  const rule = itemWithText(s, "fico_score is between 300 and 850", "rule:");
  await rule.getByRole("button", { name: "Edit", exact: true }).click();
  const minimum = s.page.getByLabel("Minimum", { exact: true });
  await minimum.fill("1e400");
  assert.equal(await minimum.evaluate((el) => el.validity.badInput), true, "the browser flags 1e400 as bad input");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  await poll(async () => /enter a number or leave it empty/.test(norm(await s.page.locator("[role='alert']").first().textContent())), "the refusal of the non-finite number");
  await s.page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(await itemWithText(s, "fico_score is between 300 and 850", "rule:").count(), "the rule keeps its lower bound");
  await settle(s, "non-finite number");
});

feature("F21", "Edit a cross-column relationship's description", {}, async (s) => {
  await pickCrossColumn(s);
  const relationship = s.page.locator("[data-review-item^='rel:']").first();
  await relationship.getByRole("button", { name: "Edit", exact: true }).click();
  await relationship.locator("textarea").fill("Each loan has one servicer record.");
  await relationship.getByRole("button", { name: "Save as pending" }).click();
  await poll(async () => norm(await relationship.textContent()).includes("Each loan has one servicer record."), "the new relationship text");
  await settle(s, "relationship edit");
});

feature("F22", "Approve every high-confidence suggestion in one click", {}, async (s) => {
  const button = s.page.getByRole("button", { name: /^Approve \d+ high-confidence$/ });
  const n = Number((await button.textContent()).match(/\d+/)[0]);
  assert.equal(n, 98, "README: 98 high-confidence suggestions");
  await button.click();
  await poll(async () => (await progressCounts(s)).approved === 98, "98 approved");
  const after = await progressCounts(s);
  assert.equal(after.pending, 18, "18 still waiting");
  assert.equal(await s.page.getByRole("button", { name: /high-confidence$/ }).count(), 0, "the bulk button goes away");
  assert.match(norm(await topHeader(s).textContent()), /Audit log98/, "every decision is in the audit log");
  await settle(s, "approve high-confidence");
});

feature("F23", "Approve every pending suggestion for one column", {}, async (s) => {
  await pickColumn(s, "loan_id");
  const before = await progressCounts(s);
  const button = s.page.getByRole("button", { name: /^Approve all \d+ for this column$/ });
  const n = Number((await button.textContent()).match(/\d+/)[0]);
  await button.click();
  await poll(async () => (await progressCounts(s)).approved === before.approved + n, `${n} more approvals`);
  assert.ok((await s.page.locator("nav[aria-label='Columns'] button").filter({ hasText: "reviewed" }).count()) >= 1, "the rail marks it reviewed");
  await settle(s, "approve all for column");
});

feature("F24", "Start reviewing walks suggestions in on-screen order, highlights them, and narrates", {}, async (s) => {
  const narration = () => overview(s).locator("p[aria-live='polite']").first().textContent();
  await overview(s).getByRole("button", { name: "Start reviewing", exact: true }).click();
  await poll(async () => norm(await narration()).includes("Now reviewing the description Claude suggested for loan_id"), "the first narration");
  assert.equal(await s.page.evaluate(() => document.activeElement?.hasAttribute("data-approve")), true, "keyboard is on the Approve button");
  assert.ok((await item(s, "def:loan_id").getAttribute("class")).includes("ring-accent"), "the suggestion is highlighted");
  await settle(s, "start reviewing");
  await s.page.keyboard.press("Enter");
  await poll(async () => norm(await narration()).includes("sensitivity label Claude suggested for loan_id"), "the next suggestion after approving");
  assert.ok(norm(await narration()).startsWith("Approved."), "the decision is confirmed");
  await overview(s).getByRole("button", { name: "Skip to the next one" }).click();
  await poll(async () => norm(await narration()).includes("Now reviewing the rule"), "skipping moves to a rule");
  assert.equal((await progressCounts(s)).approved, 1, "skipping does not decide anything");
  await settle(s, "start reviewing and skip");
});

feature("F25", "Review queue: status tabs, kind and confidence filters, search, and empty states", {}, async (s) => {
  await queue(s);
  assert.equal((await queueRows(s).count()), 116, "all 116 pending suggestions are listed");
  await setQueueStatus(s, "Approved");
  await poll(async () => norm(await s.page.locator("main").textContent()).includes("No items match these filters"), "the empty approved list");
  await setQueueStatus(s, "Pending");
  await s.page.locator("#queue-kind").selectOption("definition");
  await poll(async () => (await queueRows(s).count()) === 25, "25 descriptions");
  await s.page.locator("#queue-kind").selectOption("all");
  await s.page.locator("#queue-confidence").selectOption("low");
  const lowRows = queueRows(s);
  await poll(async () => (await lowRows.count()) > 0, "low-confidence rows");
  const count = await lowRows.count();
  for (let i = 0; i < count; i++) {
    assert.ok((await lowRows.nth(i).locator("[title='Model confidence: low']").count()) === 1, "every row is low confidence");
  }
  await s.page.locator("#queue-confidence").selectOption("all");
  await s.page.locator("#queue-search").fill("fico");
  await poll(async () => (await queueRows(s).count()) > 0, "search results");
  const first = norm(await queueRows(s).first().textContent());
  assert.ok(first.toLowerCase().includes("fico"), "search matches the column");
  await s.page.locator("#queue-search").fill("zzzz-no-such");
  await poll(async () => norm(await s.page.locator("main").textContent()).includes("No items match these filters"), "the no-match notice");
  await s.page.locator("#queue-search").fill("");
  await settle(s, "queue filters");
});

feature("F26", "Review queue: select, approve or reject in bulk", {}, async (s) => {
  await queue(s, { kind: "definition" });
  await s.page.locator("label", { hasText: "Select all" }).locator("input").click();
  await poll(async () => norm(await s.page.locator("label", { hasText: "selected" }).textContent()).includes("25 selected"), "25 selected");
  await s.page.getByRole("button", { name: "Approve selected" }).click();
  await poll(async () => (await progressCounts(s)).approved === 25, "25 approved in bulk");
  await poll(async () => norm(await s.page.locator("main").textContent()).includes("No items match these filters"), "no pending descriptions left");
  await s.page.locator("#queue-kind").selectOption("classification");
  await s.page.locator("label", { hasText: "Select all" }).locator("input").click();
  await s.page.getByRole("button", { name: "Reject selected" }).click();
  await poll(async () => (await progressCounts(s)).rejected === 25, "25 rejected in bulk");
  await settle(s, "bulk approve and reject");
});

feature("F27", "Review queue keyboard: X selects, A approves, J and K move, R rejects, U reopens", {}, async (s) => {
  await queue(s);
  await queueRows(s).first().focus();
  await s.page.keyboard.press("x");
  assert.equal(await queueRows(s).first().locator("input[type='checkbox']").isChecked(), true, "X selects the row");
  await s.page.keyboard.press("a");
  await poll(async () => (await progressCounts(s)).approved === 1, "A approves the focused row");
  assert.equal(await s.page.evaluate(() => document.activeElement?.tagName), "LI", "focus stays in the list");
  await s.page.keyboard.press("j");
  const second = await s.page.evaluate(() => [...document.querySelectorAll("ul[aria-label='Suggestions'] > li")].indexOf(document.activeElement));
  assert.equal(second, 1, "J moves down one row");
  await s.page.keyboard.press("r");
  await poll(async () => (await progressCounts(s)).rejected === 1, "R rejects the focused row");
  await setQueueStatus(s, "All");
  await queueRows(s).first().focus();
  await s.page.keyboard.press("u");
  await poll(async () => (await progressCounts(s)).approved === 0, "U reopens the focused row");
  await s.page.keyboard.press("k");
  await settle(s, "keyboard queue");
});

feature("F28", "Review queue: Open jumps to the column or relationship of a suggestion", {}, async (s) => {
  await queue(s);
  await s.page.getByRole("button", { name: "Open servicer_id to see details or edit" }).first().click();
  await poll(async () => (await viewTitle(s)) === "servicer_id", "the servicer_id column");
  await settle(s, "queue open");
});

feature("F29", "Audit log: records decisions, downloads as JSON, and starts over after a confirm", {}, async (s) => {
  await pickColumn(s, "loan_id");
  await item(s, "def:loan_id").locator("[data-approve]").click();
  await item(s, "cls:loan_id").getByRole("button", { name: "Reject", exact: true }).click();
  await poll(async () => (await progressCounts(s)).approved === 1 && (await progressCounts(s)).rejected === 1, "two decisions");
  await topHeader(s).getByRole("button", { name: /Audit log/ }).click();
  await poll(async () => (await liveDialog(s).count()) === 1, "the audit drawer");
  const drawer = norm(await liveDialog(s).textContent());
  assert.match(drawer, /2 entries for loans_sample\.csv/);
  assert.ok(drawer.includes("Approved") && drawer.includes("Rejected"), "both decisions are listed");
  assert.ok(drawer.includes("reviewer"), "the actor is named");
  const box = await liveDialog(s).boundingBox();
  assert.ok(box.width <= VIEWPORTS[s.vp].width, "the drawer fits the viewport");
  await settle(s, "audit drawer");
  const exported = await download(s, () => liveDialog(s).getByRole("button", { name: "Download JSON" }).click());
  assert.equal(exported.name, "audit-log.json");
  const entries = JSON.parse(exported.text);
  assert.equal(entries.length, 2, "the download holds the two entries");
  assert.ok(entries.every((entry) => entry.actor === "reviewer" && entry.at), "each entry records who and when");
  s.page.once("dialog", (dialog) => dialog.accept());
  await liveDialog(s).getByRole("button", { name: "Start over" }).click();
  await poll(async () => norm(await liveDialog(s).textContent()).includes("No decisions yet"), "the cleared log");
  assert.deepEqual(await progressCounts(s), { approved: 0, rejected: 0, pending: 116, total: 116 }, "the review is reset");
  await s.page.keyboard.press("Escape");
  await poll(async () => (await liveDialog(s).count()) === 0, "the drawer closes with Escape");
  await settle(s, "start over");
});

feature("F30", "Exports hold only approved items: contract YAML, glossary CSV, and quality report", {}, async (s) => {
  await s.page.getByRole("button", { name: /^Approve \d+ high-confidence$/ }).click();
  await poll(async () => (await progressCounts(s)).approved === 98, "98 approved");

  await queue(s, { kind: "definition" });
  const defRow = queueRows(s).first();
  const defText = norm(await defRow.locator("div.line-clamp-2").textContent());
  const rejectedDefinition = defText.slice(defText.indexOf("·") + 1).trim();
  await defRow.getByRole("button", { name: "Reject", exact: true }).click();
  await poll(async () => (await progressCounts(s)).rejected === 1, "one description rejected");

  await s.page.locator("#queue-kind").selectOption("rule");
  const ruleRow = queueRows(s).first();
  await ruleRow.getByRole("button", { name: "Reject", exact: true }).click();
  await poll(async () => (await progressCounts(s)).rejected === 2, "one rule rejected");

  await setQueueStatus(s, "Approved");
  await s.page.locator("#queue-kind").selectOption("definition");
  const approvedDefinitions = await queueRows(s).count();
  assert.equal(approvedDefinitions, fixtureCounts.highDefinitions, "approved descriptions are the high-confidence ones");
  await s.page.locator("#queue-kind").selectOption("rule");
  const approvedRules = await queueRows(s).count();
  assert.ok(approvedRules > 0, "some rules are approved");
  await settle(s, "queue before export");

  const counts = await progressCounts(s);
  await goTab(s, "Exports");
  const contract = await download(s, () => s.page.getByRole("button", { name: /^Download .*\.contract\.yaml$/ }).click());
  assert.equal(contract.name, "loans_sample.contract.yaml");
  const doc = parseYaml(contract.text);
  assert.equal(doc.contract.review.approved, counts.approved, "contract: approved count matches the review");
  assert.equal(doc.contract.review.rejected, counts.rejected, "contract: rejected count matches the review");
  assert.equal(doc.contract.review.pending, counts.pending, "contract: pending count matches the review");
  assert.equal(doc.schema.length, 25, "contract: every column is listed");
  assert.equal(doc.schema.filter((column) => column.description).length, approvedDefinitions, "contract: only approved descriptions");
  const ruleEntries = doc.schema.reduce((sum, column) => sum + (column.quality?.length ?? 0), 0) + (doc.cross_column_quality?.length ?? 0);
  assert.equal(ruleEntries, approvedRules, "contract: only approved rules");
  assert.equal(doc.schema.some((column) => column.description === rejectedDefinition), false, "contract: a rejected description is absent");
  await settle(s, "contract download");

  await s.page.getByRole("group", { name: "Which export" }).getByRole("button", { name: "Business glossary" }).click();
  const glossary = await download(s, () => s.page.getByRole("button", { name: /^Download .*\.glossary\.csv$/ }).click());
  const rows = parseCsvText(glossary.text);
  assert.deepEqual(rows[0], GLOSSARY_HEADER, "glossary: header row");
  assert.equal(rows.length - 1, approvedDefinitions, "glossary: one row per approved description");
  assert.equal(rows.slice(1).some(([, , definition]) => definition === rejectedDefinition), false, "glossary: rejected description absent");
  await settle(s, "glossary download");

  await s.page.getByRole("group", { name: "Which export" }).getByRole("button", { name: "Quality report" }).click();
  const quality = await download(s, () => s.page.getByRole("button", { name: /^Download .*\.quality\.md$/ }).click());
  assert.equal(quality.name, "loans_sample.quality.md");
  assert.ok(quality.text.includes(`- Approved rules: ${approvedRules}`), "quality: approved rule count matches the review");
  const tableRows = quality.text.match(/^\| (FAIL|PASS|NOT RUN) \|/gm) ?? [];
  assert.equal(tableRows.length, approvedRules, "quality: one table row per approved rule");
  assert.ok(quality.text.includes("Only rules a reviewer approved are listed."), "quality: the report says it lists only approved rules");
  await settle(s, "quality download");
});

feature("F31", "Exports: copy, switch between the three views, and the contract preview", {}, async (s) => {
  await s.page.getByRole("button", { name: /^Approve \d+ high-confidence$/ }).click();
  await goTab(s, "Exports");
  const which = s.page.getByRole("group", { name: "Which export" });
  await s.page.getByRole("button", { name: "Copy", exact: true }).click();
  await s.page.getByRole("button", { name: "Copied", exact: true }).waitFor({ timeout: 4000 });
  await which.getByRole("button", { name: "Business glossary" }).click();
  await poll(async () => (await which.getByRole("button", { name: "Business glossary" }).getAttribute("aria-pressed")) === "true", "the glossary tab");
  assert.match(norm(await s.page.locator("main").textContent()), /CSV columns: term, column, definition, classification, data_type, approved_by, approved_at/);
  await which.getByRole("button", { name: "Quality report" }).click();
  assert.match(norm(await s.page.locator("main").textContent()), /Approved rules: 116|Approved rules/);
  await which.getByRole("button", { name: "Data contract" }).click();
  assert.match(await s.page.locator("pre[aria-label^='Preview of']").textContent(), /Data contract for loans_sample\.csv/);
  await settle(s, "export views");
});

feature("F32", "Exports before anything is approved explain what is missing", {}, async (s) => {
  await goTab(s, "Exports");
  assert.match(norm(await s.page.locator("main").textContent()), /Nothing is approved yet, so the exports hold only facts from the profiler/);
  const which = s.page.getByRole("group", { name: "Which export" });
  await which.getByRole("button", { name: "Business glossary" }).click();
  assert.ok(norm(await s.page.locator("main").textContent()).includes("The glossary is empty"), "empty glossary explained");
  await which.getByRole("button", { name: "Quality report" }).click();
  assert.ok(norm(await s.page.locator("main").textContent()).includes("No approved rules yet"), "empty quality report explained");
  await settle(s, "empty exports");
});

feature("F33", "When everything is decided, the overview points at the data contract", {}, async (s) => {
  await queue(s);
  await s.page.locator("label", { hasText: "Select all" }).locator("input").click();
  await s.page.getByRole("button", { name: "Approve selected" }).click();
  await poll(async () => (await progressCounts(s)).approved === 116, "all 116 approved");
  const narration = await overview(s).locator("p[aria-live='polite']").first().textContent();
  assert.ok(norm(narration).includes("All 116 suggestions are decided, so the exports are complete."), "the overview says so");
  await overview(s).getByRole("button", { name: "See the data contract" }).click();
  await poll(async () => (await viewTitle(s)) === "Exports", "the exports view");
  await settle(s, "all decided");
});

feature("F34", "The sample review survives a reload", {}, async (s) => {
  await s.page.getByRole("button", { name: /^Approve \d+ high-confidence$/ }).click();
  const before = await progressCounts(s);
  assert.equal(before.approved, 98);
  await s.page.reload({ waitUntil: "networkidle" });
  await poll(async () => (await progressCounts(s)).approved === 98, "the saved review after reload");
  assert.match(norm(await topHeader(s).textContent()), /Audit log98/, "the audit log is kept too");
  await settle(s, "reload");
});

feature("F35", "Keyboard: skip link, and Escape closes the audit drawer", {}, async (s) => {
  await s.page.keyboard.press("Tab");
  assert.equal(await s.page.evaluate(() => document.activeElement?.textContent), "Skip to content", "the first Tab reaches the skip link");
  await s.page.keyboard.press("Enter");
  assert.equal(await s.page.evaluate(() => location.hash), "#main", "the skip link jumps to the main content");
  await topHeader(s).getByRole("button", { name: /Audit log/ }).click();
  await poll(async () => (await liveDialog(s).count()) === 1, "the audit drawer");
  await s.page.keyboard.press("Escape");
  await poll(async () => (await liveDialog(s).count()) === 0, "the drawer closes");
  await settle(s, "keyboard");
});

feature("F36", "Demo build: the upload dialog explains that the API is needed", { build: "demo" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  const dialog = liveDialog(s);
  await dialog.locator("h2").waitFor();
  const text = norm(await dialog.textContent());
  assert.ok(text.includes("Uploads and live runs need the Steward API, which is not connected here"), "the dialog says the API is not connected");
  assert.ok(text.includes("uv run uvicorn app.main:app --port 8130"), "the dialog shows the command to start it");
  assert.equal(await dialog.getByRole("button", { name: "Choose a CSV", exact: true }).isDisabled(), true, "uploads are disabled");
  assert.equal(await dialog.getByRole("button", { name: "Add key", exact: true }).isDisabled(), true, "adding a key is disabled");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes");
  await settle(s, "demo upload dialog");
});

feature("F37", "Demo build: the sample makes no request to the API", { build: "demo" }, async (s) => {
  await s.page.getByRole("button", { name: /^Approve \d+ high-confidence$/ }).click();
  await queue(s);
  await goTab(s, "Exports");
  await download(s, () => s.page.getByRole("button", { name: /^Download .*\.contract\.yaml$/ }).click());
  assert.deepEqual(s.apiRequests, [], "no request went to the API origin");
  assert.deepEqual(s.externalRequests, [], "no request went to any other origin");
  await settle(s, "no API calls");
});

feature("F38", "API build: the upload dialog reports the connection", { build: "api" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  const dialog = liveDialog(s);
  await dialog.locator("h2").waitFor();
  assert.ok(norm(await dialog.textContent()).includes(`Connected to ${API}`), "the dialog names the API it is connected to");
  assert.equal(await dialog.getByRole("button", { name: "Choose a CSV", exact: true }).isDisabled(), false, "uploads are enabled");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes");
  await settle(s, "api upload dialog");
});

feature("F39", "API build: the key dialog refuses a malformed key and accepts a well-formed one", { build: "api" }, async (s) => {
  await s.page.locator("div[role='status']").first().getByRole("button", { name: "Add key" }).click();
  const dialog = liveDialog(s);
  await dialog.locator("input[name=key]").fill("abc");
  await dialog.getByRole("button", { name: "Use this key" }).click();
  await poll(async () => norm(await dialog.locator("[role='alert']").textContent()).startsWith("Anthropic keys start with sk-ant-"), "the key format error");
  await dialog.locator("input[name=key]").fill(FAKE_KEY);
  await dialog.getByRole("button", { name: "Use this key" }).click();
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes after a valid format");
  await poll(async () => norm(await s.page.locator("div[role='status']").first().textContent()).includes("Live: Claude Opus 5.5 runs with your key."), "the live banner");
  await s.page.locator("div[role='status']").first().getByRole("button", { name: "Change key" }).click();
  await liveDialog(s).getByRole("button", { name: "Remove key" }).click();
  await poll(async () => norm(await s.page.locator("div[role='status']").first().textContent()).includes("Add your Anthropic API key to run it live."), "the banner after removing the key");
  await settle(s, "key dialog");
});

feature("F40", "API build: a valid CSV uploads and is profiled, with no suggestions yet", { build: "api" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  await liveDialog(s).locator("input[type=file]").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: Buffer.from(CSV_ORDERS) });
  await poll(async () => norm(await progress(s).textContent()).includes("orders.csv · 240 rows · 6 columns"), "the profiled upload");
  assert.ok(norm(await progress(s).textContent()).includes("No suggestions yet"), "no suggestions before the assessment");
  assert.equal(await overview(s).getByRole("button", { name: "Run the assessment" }).count(), 1, "the overview offers the assessment");
  await s.page.keyboard.press("Escape");
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes");
  await pickColumn(s, "customer_email");
  await settle(s, "upload profiled");
});

feature("F41", "API build: bad headers are cleaned up, and the original header is kept", { build: "api" }, async (s) => {
  const csv = "Loan ID,1st,,Loan ID,Amount ($)\n1,2,3,4,5\n6,7,8,9,10\n11,12,13,14,15\n";
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  await liveDialog(s).locator("input[type=file]").setInputFiles({ name: "bad-headers.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await poll(async () => norm(await progress(s).textContent()).includes("bad-headers.csv · 3 rows · 5 columns"), "the profiled upload");
  await s.page.keyboard.press("Escape");
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes");
  await pickColumn(s, "loan_id_1");
  assert.match(norm(await s.page.locator("main").textContent()), /Header in the file:\s*Loan ID_1/, "the original header is shown");
  await settle(s, "bad headers");
});

feature("F42", "API build: a file over 5 MB is refused in the browser, before anything is sent", { build: "api" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, "a");
  await liveDialog(s).locator("input[type=file]").setInputFiles({ name: "too-big.csv", mimeType: "text/csv", buffer: big });
  await poll(async () => norm(await liveDialog(s).textContent()).includes("That file is larger than the 5 MB limit."), "the size error");
  assert.equal(s.apiRequests.filter((request) => request.includes("/api/profile")).length, 0, "nothing was sent for profiling");
  await settle(s, "file too large");
});

feature("F43", "API build: a header-only CSV shows the API's message", { build: "api" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  await liveDialog(s).locator("input[type=file]").setInputFiles({ name: "header-only.csv", mimeType: "text/csv", buffer: Buffer.from("a,b,c\n") });
  await poll(async () => norm(await liveDialog(s).locator("[role='alert']").textContent()).includes("The file has a header but no data rows."), "the API message");
  assert.ok(s.apiResponses.some((response) => response.status === 400 && response.url.endsWith("/api/profile")), "the API answered 400 for the profile request");
  await settle(s, "header only");
});

feature("F44", "API build: going back to the sample restores its review", { build: "api" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  await liveDialog(s).locator("input[type=file]").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: Buffer.from(CSV_ORDERS) });
  await poll(async () => norm(await progress(s).textContent()).includes("orders.csv"), "the upload");
  await liveDialog(s).getByRole("button", { name: "Back to the sample" }).click();
  await poll(async () => norm(await progress(s).textContent()).includes("116 of 116 suggestions waiting for review"), "the sample is back");
  await settle(s, "back to sample");
});

feature("F45", "API build: an edited rule is re-run by the engine through the API", { build: "api" }, async (s) => {
  await pickColumn(s, "fico_score");
  const rule = itemWithText(s, "fico_score is between 300 and 850", "rule:");
  await rule.getByRole("button", { name: "Edit", exact: true }).click();
  await s.page.getByLabel("Minimum", { exact: true }).fill("620");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  const edited = itemWithText(s, "fico_score is between 620 and 850", "rule:");
  await edited.getByRole("button", { name: "Run rule" }).click();
  const failing = await poll(async () => {
    const match = norm(await edited.textContent()).match(/([\d,]+) rows? fails?/);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  }, "the re-run result", 20000);
  assert.ok(failing > 9, `a tighter range fails more than the original 9 rows (got ${failing})`);
  await settle(s, "rule re-run");
});

feature("F46", "API build: Run on all columns stays disabled until a key is set", { build: "api" }, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  const run = liveDialog(s).getByRole("button", { name: /Run on 25 columns/ });
  assert.equal(await run.isDisabled(), true, "no key, so the run is disabled");
  assert.ok(norm(await liveDialog(s).textContent()).includes("Add a key first."), "the dialog says why");
  await liveDialog(s).getByRole("button", { name: "Close", exact: true }).click();
  await settle(s, "run disabled");
});

feature("F47", "Live Claude assessment: suggestions from Opus, the strict tools, effort, and prompt caching", {
  notTestable: "No Anthropic API key exists here, and a run would call the Claude API, which is not permitted in this pass. Covered by the scripted-client tests in pytest and by `pnpm e2e:live`.",
}, async () => {});

feature("F48", "Cost meter: tokens, cache reads, and dollars for a real run", {
  notTestable: "Only a real run shows the meter; the sample shows no cost. Needs a live run, which needs a key.",
}, async () => {});

feature("F49", "Cross-column relationship pass at high effort (second Claude pass)", {
  notTestable: "Live Claude output; needs a key and a real call.",
}, async () => {});

feature("F50", "Column-level lineage graph (stretch goal)", {
  notTestable: "Cut from the MVP and not in the UI or the README; nothing to test.",
}, async () => {});

feature("F51", "Deployed site and the live-demo badge", {
  notTestable: "Nothing is deployed; the badge links to #run-locally by design.",
}, async () => {});

feature("F52", "Review queue rows: Approve and Reject on a pending row, Reopen on a decided one, and the Rejected tab", {}, async (s) => {
  const summaryText = async () => norm(await queueRows(s).first().locator("div.line-clamp-2").textContent());
  await queue(s);
  const summary = await summaryText();
  await queueRows(s).first().getByRole("button", { name: "Approve", exact: true }).click();
  await poll(async () => (await progressCounts(s)).approved === 1, "row approve");
  await setQueueStatus(s, "Approved");
  await poll(async () => (await queueRows(s).count()) === 1, "the approved row listed");
  assert.equal(await summaryText(), summary, "the approved row is the same suggestion");
  await queueRows(s).first().getByRole("button", { name: "Reopen", exact: true }).click();
  await poll(async () => (await progressCounts(s)).approved === 0, "row reopen");
  await setQueueStatus(s, "Pending");
  await queueRows(s).first().getByRole("button", { name: "Reject", exact: true }).click();
  await poll(async () => (await progressCounts(s)).rejected === 1, "row reject");
  await setQueueStatus(s, "Rejected");
  await poll(async () => (await queueRows(s).count()) === 1, "the rejected row listed");
  assert.equal(await summaryText(), summary, "the rejected row is the same suggestion");
  await queueRows(s).first().getByRole("button", { name: "Reopen", exact: true }).click();
  await poll(async () => (await progressCounts(s)).rejected === 0, "rejected row reopened");
  await settle(s, "queue row buttons");
});

feature("F53", "Review queue bulk: the selection count, Approve selected, and Reopen selected", {}, async (s) => {
  await queue(s, { kind: "definition" });
  const boxes = queueRows(s).locator("input[type='checkbox']");
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await poll(async () => norm(await s.page.locator("label", { hasText: "selected" }).textContent()).includes("2 selected"), "2 selected");
  await s.page.getByRole("button", { name: "Approve selected" }).click();
  await poll(async () => (await progressCounts(s)).approved === 2, "2 approved in bulk");
  await setQueueStatus(s, "Approved");
  await poll(async () => (await queueRows(s).count()) === 2, "two approved descriptions listed");
  await s.page.locator("label", { hasText: "Select all" }).locator("input").click();
  await poll(async () => norm(await s.page.locator("label", { hasText: "selected" }).textContent()).includes("2 selected"), "select all of the approved");
  await s.page.getByRole("button", { name: "Reopen selected" }).click();
  await poll(async () => (await progressCounts(s)).approved === 0, "bulk reopen");
  await settle(s, "bulk reopen");
});

feature("F54", "Review queue keyboard: Space selects, and the arrow keys move focus like J and K", {}, async (s) => {
  await queue(s);
  const rows = queueRows(s);
  await rows.first().focus();
  await s.page.keyboard.press(" ");
  assert.equal(await rows.first().locator("input[type='checkbox']").isChecked(), true, "Space selects the focused row");
  await s.page.keyboard.press("ArrowDown");
  const down = await s.page.evaluate(() => [...document.querySelectorAll("ul[aria-label='Suggestions'] > li")].indexOf(document.activeElement));
  assert.equal(down, 1, "ArrowDown moves to the next row");
  await s.page.keyboard.press("ArrowUp");
  const up = await s.page.evaluate(() => [...document.querySelectorAll("ul[aria-label='Suggestions'] > li")].indexOf(document.activeElement));
  assert.equal(up, 0, "ArrowUp moves back");
  await s.page.keyboard.press(" ");
  assert.equal(await rows.first().locator("input[type='checkbox']").isChecked(), false, "Space clears the selection");
  await settle(s, "keyboard space and arrows");
});

feature("F55", "Rule editor: allowed values, a choice, a column list, and severity, saved as pending", {}, async (s) => {
  await pickColumn(s, "servicer_id");
  const inSet = itemWithText(s, "servicer_id is one of", "rule:");
  await inSet.getByRole("button", { name: "Edit", exact: true }).click();
  await inSet.getByLabel("Allowed values", { exact: true }).fill("SV01\nSV02\nSV03");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  const edited = itemWithText(s, "servicer_id is one of: SV01, SV02, SV03", "rule:");
  await edited.getByText("Not run since the edit").waitFor();
  assert.equal((await progressCounts(s)).approved, 0, "a pending save is not an approval");
  await settle(s, "allowed values edited");

  await pickColumn(s, "servicer_loan_number");
  const typed = itemWithText(s, "servicer_loan_number is a valid integer", "rule:");
  await typed.getByRole("button", { name: "Edit", exact: true }).click();
  await typed.getByLabel("Type", { exact: true }).selectOption("decimal");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  await itemWithText(s, "servicer_loan_number is a valid decimal", "rule:").waitFor();
  await settle(s, "type choice edited");

  await pickColumn(s, "loan_id");
  const unique = itemWithText(s, "loan_id is unique", "rule:");
  await unique.getByRole("button", { name: "Edit", exact: true }).click();
  await unique.getByLabel("Columns", { exact: true }).selectOption("servicer_id");
  await unique.getByRole("button", { name: "Remove servicer_id" }).waitFor();
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  await itemWithText(s, "The combination of loan_id + servicer_id is unique", "rule:").waitFor();
  await settle(s, "column list edited");

  const severity = itemWithText(s, "The combination of loan_id + servicer_id is unique", "rule:");
  await severity.getByRole("button", { name: "Edit", exact: true }).click();
  await severity.getByLabel("Severity", { exact: true }).selectOption("warning");
  await s.page.getByRole("button", { name: "Save as pending" }).click();
  await poll(async () => norm(await severity.textContent()).includes("warning"), "the warning severity");
  await settle(s, "severity edited");
});

feature("F56", "Save and approve on a rule; Cancel on a description and a label throws the draft away", {}, async (s) => {
  await pickColumn(s, "servicer_id");
  const inSet = itemWithText(s, "servicer_id is one of", "rule:");
  await inSet.getByRole("button", { name: "Edit", exact: true }).click();
  await inSet.getByLabel("Allowed values", { exact: true }).fill("SV01\nSV02");
  await s.page.getByRole("button", { name: "Save and approve" }).click();
  await poll(async () => (await progressCounts(s)).approved === 1, "the rule approved");
  assert.ok(norm(await itemWithText(s, "servicer_id is one of: SV01, SV02", "rule:").textContent()).includes("Approved"), "the saved rule shows Approved");

  const def = item(s, "def:servicer_id");
  const defBefore = norm(await def.textContent());
  await def.getByRole("button", { name: "Edit", exact: true }).click();
  await def.locator("textarea").fill("A draft that must be thrown away.");
  await def.getByRole("button", { name: "Cancel", exact: true }).click();
  await poll(async () => norm(await def.textContent()) === defBefore, "the description is back to its saved text");

  const cls = item(s, "cls:servicer_id");
  const clsBefore = norm(await cls.textContent());
  await cls.getByRole("button", { name: "Edit", exact: true }).click();
  await cls.locator("select").selectOption("Restricted");
  await cls.getByRole("button", { name: "Cancel", exact: true }).click();
  await poll(async () => norm(await cls.textContent()) === clsBefore, "the label is back to its saved value");
  assert.equal((await progressCounts(s)).approved, 1, "cancelling changes nothing in the count");
  await settle(s, "save and approve, cancel");
});

feature("F57", "Cross-column relationship: Cancel discards, Save and approve approves", {}, async (s) => {
  await pickCrossColumn(s);
  const rel = s.page.locator("[data-review-item^='rel:']").first();
  const before = norm(await rel.textContent());
  await rel.getByRole("button", { name: "Edit", exact: true }).click();
  await rel.locator("textarea").fill("A draft that must be thrown away.");
  await rel.getByRole("button", { name: "Cancel", exact: true }).click();
  await poll(async () => norm(await rel.textContent()) === before, "the relationship is back to its text");
  await rel.getByRole("button", { name: "Edit", exact: true }).click();
  await rel.locator("textarea").fill("Each loan has one servicer record, approved here.");
  await rel.getByRole("button", { name: "Save and approve" }).click();
  await poll(async () => (await progressCounts(s)).approved === 1, "the relationship approved");
  assert.ok(norm(await rel.textContent()).includes("Each loan has one servicer record, approved here."), "the new text is saved");
  await settle(s, "relationship save and approve");
});

feature("F58", "Header shortcut to the data contract appears once something is approved", {}, async (s) => {
  await pickColumn(s, "loan_id");
  await item(s, "def:loan_id").locator("[data-approve]").click();
  await poll(async () => (await progressCounts(s)).approved === 1, "one approval");
  await progress(s).getByRole("button", { name: "See the data contract", exact: true }).click();
  await poll(async () => (await viewTitle(s)) === "Exports", "the exports view from the header");
  await settle(s, "header shortcut");
});

feature("F59", "Audit log: its close button and a click outside close it; cancelling Start over keeps the log", {}, async (s) => {
  await pickColumn(s, "loan_id");
  await item(s, "def:loan_id").locator("[data-approve]").click();
  await poll(async () => (await progressCounts(s)).approved === 1, "one approval");
  const openLog = () => topHeader(s).getByRole("button", { name: /Audit log/ }).click();
  await openLog();
  await poll(async () => (await liveDialog(s).count()) === 1, "the audit drawer");
  await liveDialog(s).getByRole("button", { name: "Close audit log", exact: true }).click();
  await poll(async () => (await liveDialog(s).count()) === 0, "closed with its button");
  await openLog();
  await poll(async () => (await liveDialog(s).count()) === 1, "the audit drawer again");
  if (s.vp === "desktop") {
    await s.page.mouse.click(3, 3);
    await poll(async () => (await liveDialog(s).count()) === 0, "closed by a click outside the drawer");
    await openLog();
    await poll(async () => (await liveDialog(s).count()) === 1, "the audit drawer a third time");
  }
  s.page.once("dialog", (dialog) => dialog.dismiss());
  await liveDialog(s).getByRole("button", { name: "Start over", exact: true }).click();
  await poll(async () => norm(await liveDialog(s).textContent()).includes("1 entry for loans_sample.csv"), "the log kept after cancel");
  assert.equal((await progressCounts(s)).approved, 1, "the review is kept after cancel");
  await settle(s, "audit cancel");
});

feature("F60", "Use your own data: closes with its Close button and by a click outside it", {}, async (s) => {
  await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
  await liveDialog(s).locator("h2").waitFor();
  await s.page.mouse.click(3, 3);
  await poll(async () => (await liveDialog(s).count()) === 0, "closed by a click outside");
  await settle(s, "upload dialog closed by outside click");
});

feature("F61", "Export copy: the clipboard holds exactly the text shown in the preview", {}, async (s) => {
  await s.page.getByRole("button", { name: /^Approve \d+ high-confidence$/ }).click();
  await goTab(s, "Exports");
  await s.page.getByRole("button", { name: "Copy", exact: true }).click();
  await s.page.getByRole("button", { name: "Copied", exact: true }).waitFor({ timeout: 4000 });
  const clipboard = await s.page.evaluate(() => navigator.clipboard.readText());
  const preview = await s.page.locator("pre[aria-label^='Preview of']").textContent();
  assert.equal(clipboard.trimEnd(), preview.trimEnd(), "the clipboard matches the preview");
  assert.equal(parseYaml(clipboard).contract.review.approved, 98, "the copied contract holds the 98 approvals");
  await settle(s, "copy export");
});

feature("F62", "API build: a key is kept for this tab only when asked, and never written to localStorage", { build: "api" }, async (s) => {
  const stores = () => s.page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
  const banner = () => s.page.locator("div[role='status']").first();
  await banner().getByRole("button", { name: "Add key" }).click();
  await liveDialog(s).locator("input[name=key]").fill(FAKE_KEY);
  await liveDialog(s).getByRole("button", { name: "Use this key" }).click();
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes");
  let saved = await stores();
  assert.equal(saved.local.includes(FAKE_KEY), false, "the key is not in localStorage");
  assert.equal(saved.session.includes(FAKE_KEY), false, "without Remember the key is not in sessionStorage");
  await banner().getByRole("button", { name: "Change key" }).click();
  assert.equal(await liveDialog(s).locator("input[name=remember]").isChecked(), false, "Remember starts unticked");
  await liveDialog(s).locator("input[name=remember]").check();
  await liveDialog(s).locator("input[name=key]").fill(FAKE_KEY);
  await liveDialog(s).getByRole("button", { name: "Use this key" }).click();
  await poll(async () => (await liveDialog(s).count()) === 0, "the dialog closes after Remember");
  saved = await stores();
  assert.equal(saved.session.includes(FAKE_KEY), true, "with Remember the key is in sessionStorage");
  assert.equal(saved.local.includes(FAKE_KEY), false, "even then it is not in localStorage");
  await banner().getByRole("button", { name: "Change key" }).click();
  await liveDialog(s).getByRole("button", { name: "Remove key" }).click();
  await poll(async () => norm(await banner().textContent()).includes("Add your Anthropic API key to run it live."), "the banner after removal");
  saved = await stores();
  assert.equal(saved.session.includes(FAKE_KEY), false, "removing the key clears sessionStorage");
  await settle(s, "key storage");
});

// ---------------------------------------------------------------- runner

async function detectBuild(browser) {
  const s = await openSession(browser, "desktop");
  try {
    await s.page.getByRole("button", { name: /^(Use your own data|Upload)$/ }).click();
    const dialog = norm(await liveDialog(s).textContent());
    return dialog.includes("Connected to") ? "api" : "demo";
  } finally {
    await s.context.close();
  }
}

const rows = [];
const browser = await chromium.launch();
try {
  const BUILD = await detectBuild(browser);
  console.log(`Serving the ${BUILD} build at ${WEB}${BUILD === "api" ? ` with the API at ${API}` : ""}.\n`);

  for (const f of FEATURES) {
    if (f.notTestable) {
      rows.push({ id: f.id, name: f.name, viewports: "-", result: "notTestable", detail: f.notTestable });
      continue;
    }
    if (f.build && f.build !== BUILD) {
      rows.push({ id: f.id, name: f.name, viewports: "-", result: "notTestable", detail: `needs the ${f.build} build; this run served the ${BUILD} build` });
      continue;
    }
    const viewports = f.viewports ?? ["desktop", "phone"];
    const failures = [];
    for (const vp of viewports) {
      let s = null;
      try {
        s = await openSession(browser, vp, { dark: f.dark === true });
        s.buildKind = BUILD;
        await f.run(s);
      } catch (error) {
        failures.push(`${vp}: ${error.message.split("\n")[0]}`);
      } finally {
        await s?.context.close().catch(() => {});
      }
    }
    rows.push({
      id: f.id,
      name: f.name,
      viewports: viewports.join(", "),
      result: failures.length ? "fail" : "pass",
      detail: failures.join(" ; ") || (f.dark ? "dark theme" : `${viewports.length} viewport${viewports.length > 1 ? "s" : ""}`),
    });
    console.log(`${failures.length ? "FAIL" : "ok  "} ${f.id} ${f.name}${failures.length ? `\n     ${failures.join("\n     ")}` : ""}`);
  }
} finally {
  await browser.close();
}

const failed = rows.filter((row) => row.result === "fail");
console.log("\n| Feature | Viewports | Result | Detail |");
console.log("| --- | --- | --- | --- |");
for (const row of rows) console.log(`| ${row.id} ${row.name} | ${row.viewports} | ${row.result} | ${row.detail.replace(/\|/g, "/")} |`);
const tally = (kind) => rows.filter((row) => row.result === kind).length;
console.log(`\n${tally("pass")} passed, ${failed.length} failed, ${tally("notTestable")} not testable in this run.`);
if (RESULTS_JSON) {
  mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  writeFileSync(RESULTS_JSON, JSON.stringify(rows, null, 2));
}
process.exitCode = failed.length ? 1 : 0;
