import { type WeekPoint } from '../core/insights.js';

export { weeklySeries, type WeekPoint } from '../core/insights.js';

/**
 * Server-rendered SVG charts for the standup page — no client JS, no chart
 * library, consistent with the zero-build dashboard. Chart marks use
 * dedicated steps of the brand hues (#e07020 / #1f7fae), validated for
 * lightness, chroma, CVD separation and 3:1 surface contrast; the trend
 * table below the charts remains the accessible fallback.
 */
const AMBER = '#e07020';
const BLUE = '#1f7fae';
const GRID = 'rgba(21,67,95,.12)';
const INK_MUTED = '#68798a';

// Shared geometry: one 480×168 viewBox, plot area inset for axes.
const W = 480;
const H = 168;
const M = { top: 10, right: 10, bottom: 22, left: 34 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

function x(i: number, n: number): number {
  return M.left + (PLOT_W / n) * (i + 0.5);
}

function yScale(value: number, max: number): number {
  return M.top + PLOT_H - (value / max) * PLOT_H;
}

function gridLines(max: number, ticks: number[], fmt: (v: number) => string): string {
  return ticks
    .map((v) => {
      const yy = yScale(v, max);
      return `<line x1="${M.left}" y1="${yy}" x2="${W - M.right}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>
        <text x="${M.left - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="${INK_MUTED}">${fmt(v)}</text>`;
    })
    .join('');
}

function xLabels(points: WeekPoint[]): string {
  // Label every other week to keep the axis recessive and collision-free.
  return points
    .map((p, i) =>
      i % 2 === points.length % 2
        ? `<text x="${x(i, points.length)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${INK_MUTED}">${p.label}</text>`
        : '',
    )
    .join('');
}

/** Bar with a rounded top (4px data-end) anchored square to the baseline. */
function roundedBar(cx: number, width: number, top: number, bottom: number, fill: string, title: string): string {
  const h = bottom - top;
  const r = Math.min(4, width / 2, h);
  const left = cx - width / 2;
  const d =
    h <= 0
      ? ''
      : `M${left},${bottom} L${left},${top + r} Q${left},${top} ${left + r},${top} L${left + width - r},${top} Q${left + width},${top} ${left + width},${top + r} L${left + width},${bottom} Z`;
  return `<path d="${d}" fill="${fill}"><title>${title}</title></path>`;
}

function frame(inner: string, ariaLabel: string): string {
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel}" style="width:100%;height:auto;display:block">${inner}</svg>`;
}

function empty(label: string): string {
  return `<p class="muted"><small>${label}: not enough history yet — charts appear after the first weeks of runs.</small></p>`;
}

/** Weekly participation as single-series bars on a fixed 0–100 % scale. */
export function participationChart(points: WeekPoint[]): string {
  if (!points.some((p) => p.participationPct !== null)) return empty('Participation');
  const n = points.length;
  const barW = Math.min(22, (PLOT_W / n) * 0.55);
  const bars = points
    .map((p, i) => {
      if (p.participationPct === null) return '';
      const top = yScale(p.participationPct, 100);
      const label =
        i === n - 1
          ? `<text x="${x(i, n)}" y="${Math.max(9, top - 4)}" text-anchor="middle" font-size="10" font-weight="700" fill="#22323d">${p.participationPct}%</text>`
          : '';
      return (
        roundedBar(x(i, n), barW, top, M.top + PLOT_H, AMBER, `Week of ${p.label}: ${p.participationPct}% participation`) + label
      );
    })
    .join('');
  return frame(gridLines(100, [0, 50, 100], (v) => `${v}%`) + bars + xLabels(points), 'Weekly participation percentage');
}

/** Weekly mood average as a single line with markers, fixed 1–5 scale. */
export function moodChart(points: WeekPoint[]): string {
  const known = points.map((p, i) => ({ ...p, i })).filter((p) => p.mood !== null);
  if (known.length === 0) return empty('Mood');
  const n = points.length;
  const max = 5;
  // Break the line where weeks have no data — bridging a gap would invent it.
  const path = known
    .map((p, idx) => {
      const cmd = idx === 0 || known[idx - 1]!.i !== p.i - 1 ? 'M' : 'L';
      return `${cmd}${x(p.i, n).toFixed(1)},${yScale(p.mood!, max).toFixed(1)}`;
    })
    .join(' ');
  const markers = known
    .map((p) => {
      const last = p.i === known[known.length - 1]!.i;
      return `<circle cx="${x(p.i, n)}" cy="${yScale(p.mood!, max)}" r="4" fill="${BLUE}" stroke="#fffdf9" stroke-width="2"><title>Week of ${p.label}: mood ${p.mood}/5</title></circle>${
        last
          ? `<text x="${x(p.i, n)}" y="${yScale(p.mood!, max) - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#22323d">${p.mood}</text>`
          : ''
      }`;
    })
    .join('');
  return frame(
    gridLines(max, [1, 3, 5], (v) => String(v)) +
      `<path d="${path}" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      markers +
      xLabels(points),
    'Weekly average mood on a 1 to 5 scale',
  );
}

/** Blockers opened vs resolved per week — two series, grouped bars with a legend. */
export function blockersChart(points: WeekPoint[]): string {
  const max = Math.max(...points.map((p) => Math.max(p.blockersOpened, p.blockersResolved)));
  if (max === 0) return empty('Blockers');
  const scaleMax = Math.max(2, Math.ceil(max / 2) * 2);
  const n = points.length;
  const groupW = Math.min(26, (PLOT_W / n) * 0.62);
  const barW = (groupW - 2) / 2; // 2px surface gap between the pair
  const bars = points
    .map((p, i) => {
      const cx = x(i, n);
      return (
        roundedBar(cx - (barW + 2) / 2, barW, yScale(p.blockersOpened, scaleMax), M.top + PLOT_H, AMBER, `Week of ${p.label}: ${p.blockersOpened} opened`) +
        roundedBar(cx + (barW + 2) / 2, barW, yScale(p.blockersResolved, scaleMax), M.top + PLOT_H, BLUE, `Week of ${p.label}: ${p.blockersResolved} resolved`)
      );
    })
    .join('');
  const legend = `<g font-size="9" fill="${INK_MUTED}">
    <rect x="${W - M.right - 118}" y="${M.top - 4}" width="8" height="8" rx="2" fill="${AMBER}"/>
    <text x="${W - M.right - 106}" y="${M.top + 3}">opened</text>
    <rect x="${W - M.right - 60}" y="${M.top - 4}" width="8" height="8" rx="2" fill="${BLUE}"/>
    <text x="${W - M.right - 48}" y="${M.top + 3}">resolved</text>
  </g>`;
  return frame(
    gridLines(scaleMax, [0, scaleMax / 2, scaleMax], (v) => String(v)) + bars + legend + xLabels(points),
    'Blockers opened and resolved per week',
  );
}
