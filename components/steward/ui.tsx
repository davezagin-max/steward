import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Status } from "@/lib/steward/review";
import type { Confidence, Sensitivity, Severity } from "@/lib/steward/types";

export type Tone = "neutral" | "accent" | "success" | "danger" | "warn" | "info" | "rose";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface text-muted border-border",
  accent: "bg-accent-soft text-accent-ink border-transparent",
  success: "bg-success-soft text-success border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  info: "bg-info-soft text-info border-transparent",
  rose: "bg-rose-soft text-rose border-transparent",
};

export function Chip({
  tone = "neutral",
  children,
  title,
  dashed = false,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  dashed?: boolean;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[11px] font-medium leading-[18px] ${TONES[tone]} ${dashed ? "border-dashed !border-border-strong" : ""} ${className}`}
    >
      {children}
    </span>
  );
}

export const SENSITIVITY_TONE: Record<Sensitivity, Tone> = {
  Public: "neutral",
  Internal: "info",
  Confidential: "warn",
  Restricted: "rose",
};

/** A sensitivity class. Dashed while it is still only a suggestion. */
export function SensitivityChip({ value, proposed = false }: { value: Sensitivity; proposed?: boolean }) {
  return (
    <Chip
      tone={SENSITIVITY_TONE[value]}
      dashed={proposed}
      title={proposed ? `${value} (suggested, not yet approved)` : `${value} (approved)`}
    >
      {value}
    </Chip>
  );
}

const STATUS: Record<Status, { tone: Tone; label: string; icon: IconName }> = {
  pending: { tone: "neutral", label: "Pending", icon: "dot" },
  approved: { tone: "success", label: "Approved", icon: "check" },
  rejected: { tone: "danger", label: "Rejected", icon: "x" },
};

export function StatusChip({ status, edited = false }: { status: Status; edited?: boolean }) {
  const { tone, label, icon } = STATUS[status];
  return (
    <Chip tone={tone}>
      <Icon name={icon} className="size-3" />
      {label}
      {edited && <span className="font-normal opacity-80">· edited</span>}
    </Chip>
  );
}

export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  const filled = confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-muted"
      title={`Model confidence: ${confidence}`}
    >
      <span aria-hidden className="inline-flex items-end gap-px">
        {[1, 2, 3].map((level) => (
          <span
            key={level}
            className={`w-[3px] rounded-[1px] ${level <= filled ? "bg-accent" : "bg-border-strong"}`}
            style={{ height: 3 + level * 3 }}
          />
        ))}
      </span>
      {confidence} confidence
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <Chip tone={severity === "error" ? "danger" : "warn"} title={severity === "error" ? "Blocks the record" : "Monitor only"}>
      {severity}
    </Chip>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTONS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border-transparent hover:opacity-90",
  secondary: "bg-bg text-fg border-border-strong hover:bg-surface",
  ghost: "bg-transparent text-muted border-transparent hover:bg-surface hover:text-fg",
  danger: "bg-bg text-danger border-border-strong hover:bg-danger-soft",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-[13px]"} ${BUTTONS[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({
  title,
  aside,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`rounded-lg border border-border bg-bg ${className}`}>
      {(title || aside) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

/** Small uppercase label above a group of facts. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[11px] font-semibold uppercase tracking-wide text-muted ${className}`}>{children}</p>
  );
}

export function Code({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <code className={`font-mono text-[0.92em] ${className}`}>{children}</code>;
}

/** Pass and fail as one bar. A failing share always gets a visible sliver. */
export function PassFailBar({ passed, failed }: { passed: number; failed: number }) {
  const total = passed + failed;
  const failShare = total ? failed / total : 0;
  const failWidth = failed ? Math.max(failShare * 100, 2.5) : 0;
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface"
      role="img"
      aria-label={`${passed} rows pass, ${failed} rows fail`}
    >
      <div className="bg-accent" style={{ width: `${100 - failWidth}%` }} />
      {failed > 0 && <div className="bg-danger" style={{ width: `${failWidth}%` }} />}
    </div>
  );
}

export type IconName =
  | "check"
  | "x"
  | "dot"
  | "pencil"
  | "chevron"
  | "alert"
  | "download"
  | "copy"
  | "history"
  | "upload"
  | "search"
  | "shield"
  | "key"
  | "link"
  | "play"
  | "undo"
  | "info";

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  dot: <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />,
  pencil: <path d="M10.5 3.5l2 2L6 12l-2.5.5L4 10z" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  alert: <path d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.2v.3" />,
  download: <path d="M8 2.5v7.5M5 7.5l3 3 3-3M3 13h10" />,
  copy: <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
  history: <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4M2.5 3v3h3M8 5v3.2l2 1.3" />,
  upload: <path d="M8 10.5V3M5 6l3-3 3 3M3 13h10" />,
  search: <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3 3" />,
  shield: <path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z" />,
  key: <path d="M10.5 9a3 3 0 1 0-2.8-2L3 11.7V13h2v-1.5h1.5V10H8l.7-.7c.5.4 1.1.7 1.8.7zM11 5.5v0" />,
  link: <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />,
  play: <path d="M5 3.5l7 4.5-7 4.5z" />,
  undo: <path d="M5.5 4L3 6.5 5.5 9M3 6.5h6a3.5 3.5 0 0 1 0 7H7" />,
  info: <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.5v3.5M8 5v.3" />,
};

export function Icon({ name, className = "size-3.5" }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}

/** A designed empty or explanatory state. */
export function Notice({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: "neutral" | "warn" | "danger" | "accent";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    neutral: "border-border bg-surface",
    warn: "border-transparent bg-warn-soft",
    danger: "border-transparent bg-danger-soft",
    accent: "border-transparent bg-accent-soft",
  };
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-[13px] ${tones[tone]}`}>
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-muted">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** A raw value in a box, with leading and trailing spaces drawn as a visible mark. */
export function RawValue({ value }: { value: string }) {
  const lead = value.length - value.trimStart().length;
  const trail = value.length - value.trimEnd().length;
  const mark = (count: number) =>
    count > 0 && (
      <span className="text-danger" title="space">
        {"\u2423".repeat(count)}
      </span>
    );
  return (
    <span className="whitespace-pre rounded-sm bg-surface px-1 font-mono text-xs">
      {mark(lead)}
      {value.trim()}
      {value.trim() ? mark(trail) : null}
    </span>
  );
}
