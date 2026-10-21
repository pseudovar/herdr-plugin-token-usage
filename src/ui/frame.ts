/**
 * Dashboard width. Wider than MAX_COLS, rows get hard to follow (a label far
 * from its numbers, a legend far from its chart), so the dashboard keeps to a
 * centred column of that width, and the popup opens no wider than it needs.
 */
export const MAX_COLS = 160;

/**
 * Columns a herdr popup spends outside the dashboard: two border columns, one
 * herdr keeps free beside the content, and the last column the dashboard
 * leaves empty (see `size()` in term.ts).
 */
export const POPUP_CHROME = 4;

/** Share of the pane area the popup takes when that is narrower than the dashboard. */
export const POPUP_PCT = 92;

export function frameLayout(cols: number): { w: number; margin: number } {
  const w = Math.min(cols, MAX_COLS);
  return { w, margin: Math.floor((cols - w) / 2) };
}

/**
 * Outer popup width in cells: 92% of the pane area (herdr's own rounding), but
 * never wider than the dashboard. Without the area, fall back to the percentage.
 */
export function popupWidth(areaWidth: number | null): number | string {
  if (!areaWidth || areaWidth <= 0) return `${POPUP_PCT}%`;
  return Math.min(Math.floor((areaWidth * POPUP_PCT) / 100), MAX_COLS + POPUP_CHROME);
}
