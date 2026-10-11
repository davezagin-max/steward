import type { ApiMeta } from "@/lib/api";
import { PRICING, formatUsd } from "@/lib/config";

const number = new Intl.NumberFormat("en-US");

/** Tokens and dollars for the most recent action. Pass `null` before the first call. */
export function CostMeter({ meta, className = "" }: { meta: ApiMeta | null; className?: string }) {
  if (!meta || meta.model === "none") return null;
  const { usage } = meta;
  const cached = usage.cache_read_input_tokens;
  const input = usage.input_tokens + usage.cache_creation_input_tokens + cached;
  const label =
    meta.mode === "live" ? "This run" : meta.placeholder ? "Sample (not a real run)" : "Recorded run";

  return (
    <p
      className={`inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-muted ${className}`}
      title={`Priced from ${PRICING.source} (verified ${PRICING.lastVerified})`}
    >
      <span>{label}:</span>
      <span>{number.format(input)} in</span>
      <span aria-hidden>·</span>
      <span>{number.format(usage.output_tokens)} out</span>
      {cached > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>{number.format(cached)} cached</span>
        </>
      )}
      <span aria-hidden>·</span>
      <span className="text-fg">{meta.placeholder ? "—" : formatUsd(meta.costUsd)}</span>
      {meta.model && <span>({meta.model})</span>}
    </p>
  );
}
