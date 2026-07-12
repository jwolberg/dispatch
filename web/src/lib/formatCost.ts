// T2-4 (ticket #14) — pure formatting for the per-ticket cost line.

/**
 * USD with cents, but four decimals below a dollar so a real sub-cent Actions
 * cost ($0.0160) stays visible instead of rounding to a misleading $0.00.
 */
export function usd(n: number): string {
  const decimals = Math.abs(n) < 1 ? 4 : 2;
  return `$${n.toFixed(decimals)}`;
}

/** 1_500_000 → "1.5M", 2_000 → "2.0K", 500 → "500". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
