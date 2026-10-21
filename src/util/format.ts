/** Compact number formatting for narrow sidebar and tab-bar surfaces. */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9, abs >= 1e10 ? 0 : 1) + "B";
  if (abs >= 1e6) return trim(n / 1e6, abs >= 1e7 ? 1 : 2) + "M";
  if (abs >= 1e3) return trim(n / 1e3, abs >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}

export function fmtCredits(n: number | null | undefined, suffix = "cr"): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e5) return trim(n / 1e3, 0) + "k" + suffix;
  if (abs >= 1e4) return trim(n / 1e3, 1) + "k" + suffix;
  if (abs >= 100) return Math.round(n).toLocaleString("en-US") + suffix;
  if (abs >= 10) return trim(n, 0) + suffix;
  return trim(n, 1) + suffix;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1000) return "$" + trim(n / 1000, 1) + "k";
  if (abs >= 100) return "$" + Math.round(n);
  if (abs >= 0.995 || abs === 0) return "$" + n.toFixed(2);
  return "$" + n.toFixed(abs >= 0.01 ? 2 : 3);
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toFixed(digits) + "%";
}

export function fmtPace(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return (n >= 10 ? n.toFixed(0) : n.toFixed(2)) + "×";
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + "s";
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m${s ? String(s).padStart(2, "0") + "s" : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "–";
  const d = Math.max(0, now - ts);
  if (d < 60_000) return Math.round(d / 1000) + "s ago";
  if (d < 3_600_000) return Math.round(d / 60_000) + "m ago";
  if (d < 86_400_000) return Math.round(d / 3_600_000) + "h ago";
  return Math.round(d / 86_400_000) + "d ago";
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "22 Sept": the dashboard's date style (as in "resets 1 Nov"). */
export function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** "19 Oct 11:04" */
export function fmtDateTime(ts: number): string {
  return `${fmtDay(ts)} ${fmtClock(ts)}`;
}

/** When something happened, as briefly as is unambiguous: "09:56" today, "Tue 17:48" this week, else "12 Oct". */
export function fmtWhen(ts: number, now = Date.now()): string {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (ts >= day.getTime()) return fmtClock(ts);
  day.setDate(day.getDate() - 6);
  if (ts >= day.getTime()) return `${new Date(ts).toLocaleDateString("en-AU", { weekday: "short" })} ${fmtClock(ts)}`;
  return fmtDay(ts);
}

function trim(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return digits > 0 ? s.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1") : s;
}

/** Zero-padded integer, for herdr's string-sorted `agent.view.set` tokens. */
export function sortKey(n: number, width = 12): string {
  return String(Math.max(0, Math.round(n))).padStart(width, "0");
}
