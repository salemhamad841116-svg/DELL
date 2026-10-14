import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass rounded-2xl p-4 sm:p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-ink-soft">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "bull" | "bear";
}) {
  return (
    <div className="rounded-xl border border-glass-border bg-background/60 px-3 py-2.5">
      <div className="text-[11px] text-ink-soft">{label}</div>
      <div
        className={cn(
          "num mt-1 text-lg",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-ink-soft">{hint}</div>}
    </div>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "bull" | "bear" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-glass-border px-2 py-0.5 text-[11px] font-medium text-ink",
        tone === "bull" && "text-bull",
        tone === "bear" && "text-bear",
        tone === "warn" && "text-bear",
      )}
    >
      {children}
    </span>
  );
}

export const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
export const numFmt = (v: number, digits = 2): string =>
  Number.isFinite(v) ? v.toFixed(digits) : "—";
