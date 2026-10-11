"use client";

import { useMemo, useState } from "react";
import {
  GLOSSARY_HEADER,
  contractYaml,
  glossaryCsv,
  glossaryRows,
  qualityReportMarkdown,
  qualitySummary,
  type ExportContext,
} from "@/lib/steward/exports";
import { formatInt, formatPct } from "@/lib/steward/format";
import { countItems } from "@/lib/steward/review";
import { describeRule } from "@/lib/steward/rules";
import { useWorkspace } from "./context";
import { Button, Icon, Notice, PassFailBar, SensitivityChip, SeverityChip } from "./ui";
import type { Sensitivity } from "@/lib/steward/types";

type Tab = "contract" | "glossary" | "quality";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function GlossaryPreview({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return <Notice title="The glossary is empty">Approve a column&apos;s business definition and it appears here as a term.</Notice>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-bg">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="bg-surface text-xs text-muted">
          <tr>
            {["Term", "Column", "Definition", "Classification", "Type"].map((label) => (
              <th key={label} scope="col" className="px-3 py-2 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([term, column, definition, classification, type]) => (
            <tr key={column} className="border-t border-border align-top">
              <td className="whitespace-nowrap px-3 py-2 font-medium">{term}</td>
              <td className="px-3 py-2 font-mono text-xs">{column}</td>
              <td className="px-3 py-2">{definition}</td>
              <td className="px-3 py-2">
                {classification ? <SensitivityChip value={classification as Sensitivity} /> : <span className="text-xs text-muted">not approved</span>}
              </td>
              <td className="px-3 py-2 text-xs text-muted">{type}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QualityPreview({ ctx }: { ctx: ExportContext }) {
  const summary = qualitySummary(ctx);
  if (summary.rules.length === 0) {
    return <Notice title="No approved rules yet">Approve a rule and its pass and fail counts are reported here.</Notice>;
  }
  const stats: [string, string, string?][] = [
    ["Approved rules", String(summary.rules.length)],
    ["Passing", String(summary.passing), "text-success"],
    ["Failing", String(summary.failing), summary.failing ? "text-danger" : undefined],
    ["Failed checks", formatInt(summary.rowsFailed)],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        {stats.map(([label, value, tone]) => (
          <div key={label} className="bg-bg px-4 py-2.5">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
            <dd className={`font-mono text-lg font-medium tabular-nums ${tone ?? ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="overflow-x-auto rounded-lg border border-border bg-bg">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="bg-surface text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Rule</th>
              <th scope="col" className="px-3 py-2 font-medium">Severity</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Checked</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Failed</th>
              <th scope="col" className="w-40 px-3 py-2 font-medium">Pass rate</th>
            </tr>
          </thead>
          <tbody>
            {summary.rules.map((rule) => (
              <tr key={rule.id} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{describeRule(rule.rule)}</td>
                <td className="px-3 py-2">
                  <SeverityChip severity={rule.severity} />
                </td>
                {rule.result ? (
                  <>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatInt(rule.result.evaluated)}</td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${rule.result.failed ? "font-semibold text-danger" : "text-muted"}`}>
                      {formatInt(rule.result.failed)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PassFailBar passed={rule.result.passed} failed={rule.result.failed} />
                        <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                          {rule.result.pass_rate === null ? "n/a" : formatPct(rule.result.pass_rate, 2)}
                        </span>
                      </div>
                    </td>
                  </>
                ) : (
                  <td colSpan={3} className="px-3 py-2 text-xs text-warn">
                    Not run since it was edited
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ExportPanel() {
  const { bundle, items, review, results } = useWorkspace();
  const [tab, setTab] = useState<Tab>("contract");
  const [copied, setCopied] = useState(false);
  const ctx = useMemo<ExportContext>(() => ({ bundle, items, state: review, results }), [bundle, items, review, results]);
  const counts = countItems(review, items);
  const stem = bundle.dataset.name.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || "dataset";

  const files: Record<Tab, { label: string; name: string; type: string; build: () => string }> = {
    contract: { label: "Data contract", name: `${stem}.contract.yaml`, type: "text/yaml", build: () => contractYaml(ctx) },
    glossary: { label: "Business glossary", name: `${stem}.glossary.csv`, type: "text/csv", build: () => glossaryCsv(ctx) },
    quality: { label: "Quality report", name: `${stem}.quality.md`, type: "text/markdown", build: () => qualityReportMarkdown(ctx) },
  };
  const file = files[tab];
  const yaml = tab === "contract" ? contractYaml(ctx) : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(file.build());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Exports</h2>
          <p className="mt-1 max-w-2xl text-[13px] text-muted">
            Built in your browser from the {counts.approved} approved {counts.approved === 1 ? "item" : "items"}, and updated as you
            review. {counts.pending > 0 ? `${counts.pending} pending and ${counts.rejected} rejected suggestions are left out.` : "Nothing is pending."}{" "}
            No model writes these files.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={copy}>
            <Icon name={copied ? "check" : "copy"} />
            <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          </Button>
          <Button variant="primary" onClick={() => download(file.name, file.build(), file.type)}>
            <Icon name="download" />
            Download {file.name}
          </Button>
        </div>
      </header>

      <div role="group" aria-label="Which export" className="flex gap-1 overflow-x-auto border-b border-border">
        {(Object.keys(files) as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] text-muted hover:text-fg aria-pressed:border-accent aria-pressed:font-medium aria-pressed:text-fg"
          >
            {files[value].label}
          </button>
        ))}
      </div>

      {counts.approved === 0 && (
        <Notice tone="accent" title="Nothing is approved yet, so the exports hold only facts from the profiler">
          Approve suggestions in the review queue and watch this page fill in.
        </Notice>
      )}

      {tab === "contract" && (
        <pre
          tabIndex={0}
          aria-label={`Preview of ${file.name}`}
          className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-bg p-4 font-mono text-[12.5px] leading-relaxed"
        >
          {yaml.split("\n").map((line, index) => (
            <span key={index} className={line.startsWith("#") ? "text-muted" : undefined}>
              {highlight(line)}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {tab === "glossary" && (
        <>
          <GlossaryPreview rows={glossaryRows(ctx)} />
          <p className="text-xs text-muted">
            CSV columns: {GLOSSARY_HEADER.join(", ")}. Cells that a spreadsheet would run as a formula are escaped.
          </p>
        </>
      )}
      {tab === "quality" && <QualityPreview ctx={ctx} />}
    </div>
  );
}

/** Colors the key of a `key: value` line. Purely cosmetic. */
function highlight(line: string) {
  const match = /^(\s*(?:- )?)([A-Za-z_][A-Za-z0-9_]*)(:)(.*)$/.exec(line);
  if (!match) return line;
  return (
    <>
      {match[1]}
      <span className="text-accent-ink">{match[2]}</span>
      {match[3]}
      {match[4]}
    </>
  );
}
