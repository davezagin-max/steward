const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatInt(value: number): string {
  return integer.format(value);
}

/** A share in 0..1 as a percentage that never rounds a non-zero value to "0%" or a near-total to "100%". */
export function formatPct(share: number, digits = 1): string {
  if (share === 0) return "0%";
  if (share === 1) return "100%";
  const pct = share * 100;
  const floor = 1 / 10 ** digits;
  if (pct < floor) return `<${floor}%`;
  if (pct > 100 - floor) return `>${(100 - floor).toFixed(digits)}%`;
  return `${pct.toFixed(digits)}%`;
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return integer.format(value);
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 5;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function formatCompact(value: number): string {
  return Math.abs(value) >= 10_000 ? compact.format(value) : formatNumber(value);
}

/** Days since 1970-01-01 as an ISO date. Histogram bins for date columns use epoch days. */
export function epochDayToIso(day: number): string {
  return new Date(Math.round(day) * 86_400_000).toISOString().slice(0, 10);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

/** At most three significant digits below 1, compact above 10,000: for tight spaces. */
export function formatShort(value: number): string {
  if (value !== 0 && Math.abs(value) < 1) return String(Number(value.toPrecision(3)));
  return formatCompact(Number.isInteger(value) ? value : Number(value.toFixed(2)));
}
