"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CostMeter } from "@/components/kit/CostMeter";
import { useKey } from "@/components/kit/KeyProvider";
import { ThemeToggle } from "@/components/kit/ThemeToggle";
import { MAX_UPLOAD_BYTES, apiBase, profileSource, runRules, streamAssessment, type DataSource } from "@/lib/steward/api";
import { DEMO_BUNDLE } from "@/lib/steward/bundle";
import { formatInt } from "@/lib/steward/format";
import { buildItems, countItems, highConfidencePending, type ReviewAction, type ReviewItem } from "@/lib/steward/review";
import { createReviewStore, reviewFingerprint, type ReviewStore } from "@/lib/steward/review-store";
import { ruleColumns, validateRule } from "@/lib/steward/rules";
import type { AssessEvent, AssessmentRun, Bundle, Rule, RuleResult } from "@/lib/steward/types";
import { AuditDrawer } from "./AuditDrawer";
import { ColumnDetail } from "./ColumnDetail";
import { ColumnRail, type Selection } from "./ColumnRail";
import { WorkspaceProvider, type RerunState, type Workspace } from "./context";
import { ExportPanel } from "./ExportPanel";
import { LivePanel, type LiveState } from "./LivePanel";
import { Relationships } from "./Relationships";
import { ReviewQueue } from "./ReviewQueue";
import { Button, Chip, Icon } from "./ui";

type View = "columns" | "queue" | "exports";

function itemsOf(bundle: Bundle): ReviewItem[] {
  return buildItems(bundle.run, (rule: Rule) => ruleColumns(rule, bundle.catalog));
}

/** A review store for a bundle. Only the bundled sample is remembered across reloads. */
function storeFor(bundle: Bundle, persist: boolean): ReviewStore {
  const items = itemsOf(bundle);
  const columns = bundle.profile.columns.map((column) => column.name);
  return createReviewStore({
    items,
    persistKey: persist ? reviewFingerprint(bundle.dataset.id, items, bundle.meta?.recordedAt ?? null) : null,
    isValidRule: (rule) => validateRule(rule, columns, bundle.catalog).ok,
  });
}

const EMPTY_RUN: AssessmentRun = { assessments: [], relationships: [], failures: [], passes: [] };

function applyEvent(run: AssessmentRun, event: AssessEvent): AssessmentRun {
  switch (event.type) {
    case "column":
      return { ...run, assessments: [...run.assessments, event.assessment] };
    case "column_failed":
      return { ...run, failures: [...run.failures, { column: event.column, reason: event.reason }] };
    case "relationships":
      return { ...run, relationships: event.relationships };
    case "pass":
      return { ...run, passes: [...run.passes, event.summary] };
    default:
      return run;
  }
}

function Progress({ approved, rejected, total }: { approved: number; rejected: number; total: number }) {
  const share = (count: number) => (total ? `${(count / total) * 100}%` : "0%");
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-surface"
      role="img"
      aria-label={`${approved} approved, ${rejected} rejected, ${total - approved - rejected} pending`}
    >
      <div className="bg-accent transition-[width]" style={{ width: share(approved) }} />
      <div className="bg-danger transition-[width]" style={{ width: share(rejected) }} />
    </div>
  );
}

export function Workbench() {
  const { apiKey } = useKey();
  const apiUrl = apiBase();

  const [bundle, setBundle] = useState<Bundle>(DEMO_BUNDLE);
  const [store, setStore] = useState<ReviewStore>(() => storeFor(DEMO_BUNDLE, true));
  const [extraResults, setExtraResults] = useState<Record<string, RuleResult>>({});
  const [reruns, setReruns] = useState<Record<string, RerunState>>({});
  const [live, setLive] = useState<LiveState>({ status: "idle" });
  const [view, setView] = useState<View>("columns");
  const [selection, setSelection] = useState<Selection>({ type: "column", name: DEMO_BUNDLE.profile.columns[0].name });
  const [auditOpen, setAuditOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  /** The uploaded file's text. Kept in memory only, so edited rules can be re-run on it. */
  const upload = useRef<{ name: string; csv: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const review = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const items = useMemo(() => itemsOf(bundle), [bundle]);
  const columns = useMemo(() => bundle.profile.columns.map((column) => column.name), [bundle]);
  const results = useMemo(() => ({ ...bundle.results, ...extraResults }), [bundle.results, extraResults]);
  const isSample = bundle.dataset.id === DEMO_BUNDLE.dataset.id;

  const act = useCallback((action: ReviewAction) => store.dispatch(action, items), [store, items]);

  const openColumn = useCallback((name: string) => {
    setSelection({ type: "column", name });
    setView("columns");
    window.scrollTo({ top: 0 });
  }, []);
  const openRelationships = useCallback(() => {
    setSelection({ type: "relationships" });
    setView("columns");
    window.scrollTo({ top: 0 });
  }, []);

  const source = useCallback((): DataSource => {
    return upload.current ? { csv: upload.current.csv, name: upload.current.name } : { dataset: "sample" };
  }, []);

  const rerun = useCallback(
    async (item: ReviewItem, rule: Rule) => {
      if (!apiUrl) return;
      setReruns((current) => ({ ...current, [item.id]: { status: "running" } }));
      const response = await runRules(apiUrl, source(), [rule], {
        asOf: bundle.profile.as_of,
        contextColumns: bundle.dataset.key_columns,
      });
      const result = response.ok ? response.data.results[0] : null;
      if (result && result.status !== "error") {
        setExtraResults((current) => ({ ...current, [item.id.replace(/^rule:/, "")]: result }));
        setReruns((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)));
      } else {
        const message = response.ok ? (result?.error ?? "The rule did not run.") : response.error.message;
        setReruns((current) => ({ ...current, [item.id]: { status: "error", message } }));
      }
    },
    [apiUrl, bundle.profile.as_of, bundle.dataset.key_columns, source],
  );

  function show(next: Bundle, persist: boolean) {
    setBundle(next);
    setStore(storeFor(next, persist));
    setExtraResults({});
    setReruns({});
    setSelection({ type: "column", name: next.profile.columns[0].name });
  }

  function backToSample() {
    upload.current = null;
    show(DEMO_BUNDLE, true);
    setLive({ status: "idle" });
  }

  async function onUpload(file: File) {
    if (!apiUrl) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      return setLive({ status: "error", message: `That file is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` });
    }
    setLive({ status: "profiling" });
    const csv = await file.text();
    const response = await profileSource(apiUrl, { csv, name: file.name });
    if (!response.ok) return setLive({ status: "error", message: response.error.message });
    const { profile, model_view, key_columns } = response.data;
    upload.current = { name: profile.dataset, csv };
    show(
      {
        meta: null,
        dataset: { id: "upload", name: profile.dataset, title: profile.dataset, as_of: profile.as_of, key_columns, synthetic: false },
        profile,
        model_view,
        run: null,
        results: {},
        catalog: DEMO_BUNDLE.catalog,
        planted: [],
      },
      false,
    );
    setView("columns");
    setLive({ status: "idle" });
  }

  async function onRun() {
    if (!apiUrl || !apiKey) return;
    const before = bundle;
    const working: Bundle = { ...bundle, meta: null, run: EMPTY_RUN, results: {} };
    setBundle(working);
    setStore(storeFor(working, false));
    setExtraResults({});
    setReruns({});
    setLive({ status: "assessing", done: 0, total: bundle.profile.column_count });
    abort.current = new AbortController();

    const response = await streamAssessment(
      apiUrl,
      upload.current ? { profile: bundle.profile } : { dataset: "sample" },
      apiKey,
      (event) => {
        if (event.type === "column" || event.type === "column_failed") {
          setLive({ status: "assessing", done: event.done, total: event.total });
        }
        setBundle((current) => (current.run ? { ...current, run: applyEvent(current.run, event) } : current));
      },
      abort.current.signal,
    );
    if (!response.ok) {
      // Nothing usable arrived: put the previous suggestions back.
      setBundle(before);
      setStore(storeFor(before, isSample && before === DEMO_BUNDLE));
      return setLive({
        status: "error",
        message: abort.current.signal.aborted ? "The run was cancelled." : response.error.message,
      });
    }

    const run = response.data;
    const done: Bundle = { ...working, run, meta: response.meta };
    setBundle(done);
    const proposed = itemsOf(done).flatMap((item) =>
      item.proposed.kind === "rule" ? [{ id: item.id.replace(/^rule:/, ""), rule: item.proposed.rule }] : [],
    );
    if (proposed.length) {
      setLive({ status: "running_rules" });
      const ran = await runRules(apiUrl, source(), proposed.map((entry) => entry.rule), {
        asOf: bundle.profile.as_of,
        contextColumns: bundle.dataset.key_columns,
      });
      if (!ran.ok) {
        return setLive({ status: "error", message: `The suggestions arrived, but the rules could not be run: ${ran.error.message}` });
      }
      const byId = Object.fromEntries(proposed.map((entry, index) => [entry.id, ran.data.results[index]]));
      setBundle((current) => ({ ...current, results: byId }));
    }
    setLive({ status: "idle" });
    setLiveOpen(false);
  }

  const counts = countItems(review, items);
  const confident = highConfidencePending(review, items);
  const workspace: Workspace = {
    bundle,
    columns,
    items,
    review,
    results,
    act,
    apiAvailable: !!apiUrl,
    rerun,
    reruns,
    openColumn,
    openRelationships,
  };
  const tabs: [View, string, number | null][] = [
    ["columns", "Columns", null],
    ["queue", "Review queue", counts.pending],
    ["exports", "Exports", null],
  ];

  return (
    <WorkspaceProvider value={workspace}>
      <header className="border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-fg">
              <Icon name="shield" className="size-4" />
            </span>
            <h1 className="text-[15px] font-semibold tracking-tight">Steward</h1>
            <span className="hidden text-xs text-muted xl:inline">AI data steward, with a person approving every suggestion</span>
          </div>
          <nav aria-label="Views" className="order-last flex w-full gap-1 md:order-none md:ml-2 md:w-auto">
            {tabs.map(([value, label, badge]) => (
              <button
                key={value}
                type="button"
                aria-current={view === value ? "page" : undefined}
                onClick={() => setView(value)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] text-muted hover:bg-surface hover:text-fg aria-[current]:bg-accent-soft aria-[current]:font-medium aria-[current]:text-accent-ink md:flex-none"
              >
                {label}
                {badge !== null && badge > 0 && (
                  <span className="rounded-full bg-bg px-1.5 text-[11px] font-medium tabular-nums text-fg ring-1 ring-border-strong">
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <Button onClick={() => setAuditOpen(true)}>
              <Icon name="history" />
              <span className="hidden sm:inline">Audit log</span>
              <span className="tabular-nums text-muted">{review.audit.length}</span>
            </Button>
            <Button onClick={() => setLiveOpen(true)}>
              <Icon name="upload" />
              <span className="hidden sm:inline">Use your own data</span>
              <span className="sm:hidden">Upload</span>
            </Button>
            <ThemeToggle className="h-8 !py-0 text-[13px]" />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col gap-3 px-3 py-3 sm:px-4">
        <section
          aria-label="Dataset and review progress"
          className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-bg px-4 py-3"
        >
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
              <span className="truncate">{bundle.dataset.title}</span>
              {bundle.dataset.synthetic && <Chip title="Generated with Faker. No real people or loans.">all data is fake</Chip>}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted">
              {bundle.dataset.name} · {formatInt(bundle.profile.row_count)} rows · {bundle.profile.column_count} columns · as of{" "}
              {bundle.profile.as_of}
            </p>
          </div>
          {items.length > 0 ? (
            <div className="flex min-w-56 flex-1 flex-col gap-1.5">
              <Progress approved={counts.approved} rejected={counts.rejected} total={counts.total} />
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-xs text-muted" aria-live="polite">
                  <span className="font-medium text-fg">{counts.approved}</span> approved ·{" "}
                  <span className="font-medium text-fg">{counts.rejected}</span> rejected ·{" "}
                  <span className="font-medium text-fg">{counts.pending}</span> of {counts.total} suggestions waiting for review
                </p>
                {bundle.meta && <CostMeter meta={bundle.meta} className="!text-[11px]" />}
              </div>
            </div>
          ) : (
            <p className="min-w-56 flex-1 text-[13px] text-muted">
              Profiled. No suggestions yet: run the Claude assessment to fill the review queue.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {live.status === "assessing" && (
              <span role="status" className="text-xs text-muted">
                Claude is assessing: {live.done} of {live.total} columns
              </span>
            )}
            {confident.length > 0 && (
              <Button variant="primary" onClick={() => act({ type: "approve", ids: confident })}>
                <Icon name="check" />
                Approve {confident.length} high-confidence
              </Button>
            )}
            {counts.approved > 0 && view !== "exports" && (
              <Button onClick={() => setView("exports")}>
                See the data contract
                <Icon name="chevron" />
              </Button>
            )}
            {items.length === 0 && (
              <Button variant="primary" onClick={() => setLiveOpen(true)}>
                <Icon name="play" />
                Run the assessment
              </Button>
            )}
          </div>
        </section>

        {view === "columns" && (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <ColumnRail
              selection={selection}
              onSelect={(next) => {
                setSelection(next);
                window.scrollTo({ top: 0 });
              }}
            />
            <div className="min-w-0 flex-1">
              {selection.type === "column" ? <ColumnDetail key={selection.name} name={selection.name} /> : <Relationships />}
            </div>
          </div>
        )}
        {view === "queue" && <ReviewQueue />}
        {view === "exports" && <ExportPanel />}
      </main>

      <AuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
      <LivePanel
        open={liveOpen}
        onClose={() => setLiveOpen(false)}
        apiUrl={apiUrl}
        bundle={bundle}
        isSample={isSample}
        state={live}
        onUpload={onUpload}
        onUseSample={backToSample}
        onRun={onRun}
        onCancel={() => abort.current?.abort()}
      />
    </WorkspaceProvider>
  );
}
