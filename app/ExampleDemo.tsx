"use client";

import { useState } from "react";
import { CostMeter } from "@/components/kit/CostMeter";
import { useKey } from "@/components/kit/KeyProvider";
import type { ApiMeta } from "@/lib/api";
import { callApi } from "@/lib/client";
import type { ExampleOutput } from "./api/example/route";

/** Preset requests carry a `demoId`, which is the key their recorded run is stored under. */
const PRESETS = [
  { demoId: "powder-day", topic: "a powder day in the Wasatch" },
  { demoId: "house-set", topic: "the first drop in a house set" },
];

export function ExampleDemo() {
  const { apiKey, isLive } = useKey();
  const [topic, setTopic] = useState("");
  const [result, setResult] = useState<ExampleOutput | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(body: { demoId?: string; topic: string }) {
    setBusy(true);
    setError(null);
    const response = await callApi<ExampleOutput>("/api/example", body, apiKey);
    setBusy(false);
    setMeta(response.meta ?? null);
    if (response.ok) setResult(response.data);
    else setError(response.error.message);
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.demoId}
            type="button"
            disabled={busy}
            onClick={() => run(preset)}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface disabled:opacity-50"
          >
            {preset.topic}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (topic.trim()) run({ topic: topic.trim() });
        }}
      >
        <label htmlFor="topic" className="sr-only">
          Topic
        </label>
        <input
          id="topic"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          maxLength={200}
          placeholder={isLive ? "Any topic" : "Custom topics need a key"}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !topic.trim()}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy ? "Working…" : "Write haiku"}
        </button>
      </form>
      <div aria-live="polite" className="min-h-24">
        {error && <p className="text-sm text-danger">{error}</p>}
        {result && !error && (
          <figure className="rounded-lg border border-border bg-surface p-4">
            <figcaption className="mb-2 text-sm font-medium">{result.title}</figcaption>
            {result.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </figure>
        )}
      </div>
      <CostMeter meta={meta} />
    </section>
  );
}
