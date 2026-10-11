"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CostMeter } from "@/components/kit/CostMeter";
import { useKey } from "@/components/kit/KeyProvider";
import { formatUsd } from "@/lib/config";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_COLUMNS, MAX_UPLOAD_ROWS } from "@/lib/steward/api";
import { formatInt } from "@/lib/steward/format";
import type { Bundle } from "@/lib/steward/types";
import { Button, Chip, Code, Icon, Notice } from "./ui";

export type LiveState =
  | { status: "idle" }
  | { status: "profiling" }
  | { status: "assessing"; done: number; total: number }
  | { status: "running_rules" }
  | { status: "error"; message: string };

interface LivePanelProps {
  open: boolean;
  onClose: () => void;
  apiUrl: string | null;
  bundle: Bundle;
  isSample: boolean;
  state: LiveState;
  onUpload: (file: File) => void;
  onUseSample: () => void;
  onRun: () => void;
  onCancel: () => void;
}

function Step({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
      <span
        aria-hidden
        className={`mt-0.5 flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${done ? "bg-accent text-accent-fg" : "border border-border-strong text-muted"}`}
      >
        {done ? <Icon name="check" className="size-3" /> : number}
      </span>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <div className="col-start-2 flex flex-col items-start gap-2 text-[13px] text-muted">{children}</div>
    </li>
  );
}

export function LivePanel({ open, onClose, apiUrl, bundle, isSample, state, onUpload, onUseSample, onRun, onCancel }: LivePanelProps) {
  const { isLive, openKeyModal } = useKey();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = state.status === "profiling" || state.status === "assessing" || state.status === "running_rules";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const passes = bundle.run?.passes ?? [];
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      aria-labelledby="live-title"
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(40rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border bg-bg p-0 text-fg shadow-2xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="live-title" className="text-lg font-semibold">
              Use your own data
            </h2>
            <p className="mt-1 text-[13px] text-muted">
              The sample works with no setup. Profiling a file of your own and asking Claude for suggestions run on the Steward API
              (FastAPI and DuckDB) with your Anthropic key.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>

        {!apiUrl && (
          <Notice tone="warn" title="This deployment runs without the Steward API">
            <p>
              Everything on the sample still works: the profile, the review queue, the audit log, and all three exports. To upload a
              file or run Claude live, start the API and point the app at it:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-bg p-2.5 font-mono text-[11.5px] leading-relaxed text-fg">
              {"cd server && uv run uvicorn app.main:app --port 8130\nNEXT_PUBLIC_API_URL=http://localhost:8130 pnpm dev -p 3130"}
            </pre>
          </Notice>
        )}

        <ol className="flex flex-col gap-4">
          <Step number={1} title="Steward API" done={!!apiUrl}>
            {apiUrl ? (
              <p>
                Connected to <Code className="text-fg">{apiUrl}</Code>. Profiling and rule runs need no key.
              </p>
            ) : (
              <p>Not configured.</p>
            )}
          </Step>

          <Step number={2} title="Dataset" done={!isSample}>
            <p>
              Current: <Code className="text-fg">{bundle.dataset.name}</Code>{" "}
              {isSample ? <Chip>bundled sample</Chip> : <Chip tone="accent">your upload</Chip>} {formatInt(bundle.profile.row_count)} rows,{" "}
              {bundle.profile.column_count} columns.
            </p>
            <p className="text-xs">
              CSV up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB, {formatInt(MAX_UPLOAD_ROWS)} rows, and {MAX_UPLOAD_COLUMNS} columns. It is
              parsed into an in-memory DuckDB for the length of one request and never written to disk. Headers are rewritten to
              plain identifiers.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Choose a CSV file"
                tabIndex={-1}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onUpload(file);
                }}
              />
              <Button disabled={!apiUrl || busy} onClick={() => fileRef.current?.click()}>
                <Icon name="upload" />
                {state.status === "profiling" ? "Profiling…" : "Choose a CSV"}
              </Button>
              {!isSample && (
                <Button variant="ghost" disabled={busy} onClick={onUseSample}>
                  Back to the sample
                </Button>
              )}
            </div>
          </Step>

          <Step number={3} title="Anthropic key" done={isLive}>
            <p>
              {isLive
                ? "A key is set for this tab. It is sent only with the assessment request, in a header, and never stored."
                : "Needed for Claude's suggestions only. It stays in this tab and travels in a request header."}
            </p>
            <Button onClick={openKeyModal}>
              <Icon name="key" />
              {isLive ? "Change key" : "Add key"}
            </Button>
          </Step>

          <Step number={4} title="Run the assessment" done={!busy && bundle.meta?.mode === "live"}>
            <p>
              Pass 1 makes one call per column at low effort. Pass 2 makes one call at high effort for cross-column relationships.
              Both reuse one cached prompt that holds the masked profile: Claude sees aggregates and value shapes, never rows.
              {bundle.run ? " Running replaces the current suggestions and the review of them." : ""}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {state.status === "assessing" || state.status === "running_rules" ? (
                <Button variant="danger" onClick={onCancel}>
                  Cancel
                </Button>
              ) : (
                <Button variant="primary" disabled={!apiUrl || !isLive || busy} onClick={onRun}>
                  <Icon name="play" />
                  Run on {bundle.profile.column_count} columns
                </Button>
              )}
              {!isLive && apiUrl && <span className="text-xs">Add a key first.</span>}
            </div>
            <div aria-live="polite" className="w-full">
              {state.status === "assessing" && (
                <div className="flex flex-col gap-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${state.total ? (state.done / state.total) * 100 : 0}%` }} />
                  </div>
                  <p className="text-xs">
                    {state.done < state.total
                      ? `Assessing columns: ${state.done} of ${state.total}`
                      : "Columns done. Finding cross-column relationships…"}
                  </p>
                </div>
              )}
              {state.status === "running_rules" && <p className="text-xs">Running the proposed rules on the dataset…</p>}
              {state.status === "error" && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                  {state.message}
                </p>
              )}
            </div>
          </Step>
        </ol>

        {bundle.meta && (
          <footer className="flex flex-col gap-2 border-t border-border pt-3">
            <CostMeter meta={bundle.meta} />
            {passes.length > 0 && !bundle.meta.placeholder && (
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Token usage by pass</caption>
                <thead className="text-muted">
                  <tr>
                    {["Pass", "Effort", "Calls", "Cached tokens read", "Output tokens", "Cost"].map((label, index) => (
                      <th key={label} scope="col" className={`py-1 font-medium ${index > 1 ? "text-right" : ""}`}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {passes.map((pass) => (
                    <tr key={pass.name} className="border-t border-border">
                      <td className="py-1 font-sans">{pass.name === "columns" ? "Per column" : "Relationships"}</td>
                      <td className="py-1 font-sans">{pass.effort}</td>
                      <td className="py-1 text-right">
                        {pass.calls}
                        {pass.retries ? ` (${pass.retries} retried)` : ""}
                      </td>
                      <td className="py-1 text-right">{formatInt(pass.usage.cache_read_input_tokens)}</td>
                      <td className="py-1 text-right">{formatInt(pass.usage.output_tokens)}</td>
                      <td className="py-1 text-right">{formatUsd(pass.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
}
