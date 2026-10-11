/**
 * Smoke test of the main path in demo mode: no key, no API, no network.
 *
 * It renders the real first screen on the server, then walks the path a visitor takes:
 * approve the high-confidence suggestions in bulk, and read the three exports that are
 * generated from the approved state.
 */
import { renderToString } from "react-dom/server";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { KeyProvider } from "@/components/kit/KeyProvider";
import { apiBase } from "@/lib/steward/api";
import { DEMO_BUNDLE } from "@/lib/steward/bundle";
import { contractYaml, glossaryRows, qualitySummary, type ExportContext } from "@/lib/steward/exports";
import { buildItems, countItems, highConfidencePending, initialState } from "@/lib/steward/review";
import { createReviewStore, reviewFingerprint } from "@/lib/steward/review-store";
import { ruleColumns, validateRule } from "@/lib/steward/rules";
import type { Rule } from "@/lib/steward/types";

const bundle = DEMO_BUNDLE;
const columns = bundle.profile.columns.map((column) => column.name);
const items = buildItems(bundle.run, (rule: Rule) => ruleColumns(rule, bundle.catalog));

afterEach(() => vi.unstubAllGlobals());

describe("demo mode", () => {
  it("renders the sample, already profiled, with suggestions waiting for review", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(apiBase()).toBeNull();

    const html = renderToString(
      <KeyProvider>
        <Home />
      </KeyProvider>,
    );
    const text = html.replace(/<!-- -->/g, "");
    expect(text).toContain("Demo mode");
    expect(text).toContain(bundle.dataset.title);
    expect(text).toContain("5,014 rows");
    expect(text).toContain(`${items.length} suggestions waiting for review`);
    // The first column is open with its profile, its assessment, and its rules.
    const first = bundle.run!.assessments[0];
    expect(text).toMatch(new RegExp(`<h2[^>]*>${first.column}</h2>`));
    expect(text).toContain("computed by DuckDB, not by the model");
    expect(text).toContain(first.business_definition.replaceAll("'", "&#x27;"));
    expect(text).toContain(`Proposed rules for this column (${first.rules.length})`);
    expect(text).toMatch(/Approve \d+ high-confidence/);
    // Every column is in the rail, and nothing claims to be a recorded run while it is a placeholder.
    for (const name of columns) expect(text).toContain(name);
    if (bundle.meta?.placeholder) expect(text).toContain("Sample (not a real run)");
    expect(text).toContain("Built with Claude Code and Claude Opus 5.5.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("one bulk approval fills the contract, the glossary, and the quality report", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
    const options = {
      items,
      persistKey: reviewFingerprint(bundle.dataset.id, items, bundle.meta?.recordedAt ?? null),
      isValidRule: (rule: Rule) => validateRule(rule, columns, bundle.catalog).ok,
      now: () => "2026-10-11T16:00:00.000Z",
    };
    const store = createReviewStore(options);
    expect(store.getServerSnapshot()).toEqual(initialState(items));
    const before: ExportContext = { bundle, items, state: store.getSnapshot(), results: bundle.results };
    expect(glossaryRows(before)).toEqual([]);
    expect(qualitySummary(before).rules).toEqual([]);

    let notified = 0;
    store.subscribe(() => (notified += 1));
    const confident = highConfidencePending(store.getSnapshot(), items);
    expect(confident.length).toBeGreaterThan(10);
    store.dispatch({ type: "approve", ids: confident }, items);
    expect(notified).toBe(1);

    const state = store.getSnapshot();
    const counts = countItems(state, items);
    expect(counts.approved).toBe(confident.length);
    expect(state.audit).toHaveLength(confident.length);
    expect(new Set(state.audit.map((entry) => entry.actor))).toEqual(new Set(["reviewer"]));

    const after: ExportContext = { bundle, items, state, results: bundle.results };
    const contract = parse(contractYaml(after));
    expect(contract.contract.review).toMatchObject({ approved: counts.approved, pending: counts.pending });
    expect(contract.schema).toHaveLength(columns.length);
    const described = contract.schema.filter((column: { description?: string }) => column.description);
    expect(described).toHaveLength(glossaryRows(after).length);
    expect(described.length).toBeGreaterThan(5);
    const quality = qualitySummary(after);
    expect(quality.rules.length).toBeGreaterThan(5);
    expect(quality.notRun).toBe(0);
    expect(quality.passing + quality.failing).toBe(quality.rules.length);

    // The review survives a reload: a new store reads the same decisions back.
    const reloaded = createReviewStore(options);
    expect(reloaded.getSnapshot()).toEqual(state);
    // Starting over clears the saved copy too.
    reloaded.dispatch({ type: "reset" }, items);
    expect(stored.size).toBe(0);
  });
});
