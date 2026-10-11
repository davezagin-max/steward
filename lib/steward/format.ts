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

/**
 * When an audit entry was written, in local time: the time alone for today, with the date
 * in front for any other day. A saved review can be reopened days later.
 */
export function formatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${day}, ${time}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

/** For tight spaces: three significant digits below 1, three decimals below 1,000, compact above. */
export function formatShort(value: number): string {
  const abs = Math.abs(value);
  if (value !== 0 && abs < 1) return String(Number(value.toPrecision(3)));
  if (abs < 1000) return String(Number(value.toFixed(3)));
  return formatCompact(Math.round(value));
}
