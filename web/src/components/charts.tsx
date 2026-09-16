import type { WeekPoint } from '../lib/api';

/**
 * Ported from the retired server-rendered dashboard (charts.ts, removed in
 * the v2 cut-over) — same 480×168 viewBox, insets and
 * validated marks (amber / blue steps of the brand hues, checked for
 * lightness, chroma, CVD separation and 3:1 surface contrast).
 */
const AMBER = 'var(--chart-1)';
const BLUE = 'var(--chart-2)';
const GRID = 'rgba(21,67,95,.12)';
const INK_MUTED = 'var(--text-muted)';
const INK = 'var(--text-primary)';
const W = 480;
const H = 168;
const M = { top: 10, right: 10, bottom: 22, left: 34 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const x = (i: number, n: number) => M.left + (PLOT_W / n) * (i + 0.5);
const yScale = (value: number, max: number) => M.top + PLOT_H - (value / max) * PLOT_H;

function GridLines({ max, ticks, fmt }: { max: number; ticks: number[]; fmt: (v: number) => string }) {
  return (
    <>
      {ticks.map((v) => {
        const yy = yScale(v, max);
        return (
          <g key={v}>
            <line x1={M.left} y1={yy} x2={W - M.right} y2={yy} stroke={GRID} strokeWidth="1" />
            <text x={M.left - 6} y={yy + 3} textAnchor="end" fontSize="9" fill={INK_MUTED}>{fmt(v)}</text>
          </g>
        );
      })}
    </>
  );
}

function XLabels({ points }: { points: WeekPoint[] }) {
  // Label every other week to keep the axis recessive and collision-free.
  return (
    <>
      {points.map((p, i) =>
        i % 2 === points.length % 2 ? (
          <text key={p.label + i} x={x(i, points.length)} y={H - 6} textAnchor="middle" fontSize="9" fill={INK_MUTED}>{p.label}</text>
        ) : null,
      )}
    </>
  );
}

/** Bar with a rounded top (4px data-end) anchored square to the baseline. */
export function roundedBarPath(cx: number, width: number, top: number, bottom: number): string {
  const h = bottom - top;
  const r = Math.min(4, width / 2, h);
  const left = cx - width / 2;
  return h <= 0
    ? ''
    : `M${left},${bottom} L${left},${top + r} Q${left},${top} ${left + r},${top} L${left + width - r},${top} Q${left + width},${top} ${left + width},${top + r} L${left + width},${bottom} Z`;
}

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {children}
    </svg>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="t-small muted" style={{ margin: 0 }}>{label}: not enough history yet — charts appear after the first weeks of runs.</p>;
}

/** Weekly participation as single-series bars on a fixed 0–100 % scale. */
export function ParticipationChart({ points }: { points: WeekPoint[] }) {
  if (!points.some((p) => p.participationPct !== null)) return <Empty label="Participation" />;
  const n = points.length;
  const barW = Math.min(22, (PLOT_W / n) * 0.55);
  return (
    <Frame label="Weekly participation percentage">
      <GridLines max={100} ticks={[0, 50, 100]} fmt={(v) => `${v}%`} />
      {points.map((p, i) => {
        if (p.participationPct === null) return null;
        const top = yScale(p.participationPct, 100);
        return (
          <g key={i}>
            <path d={roundedBarPath(x(i, n), barW, top, M.top + PLOT_H)} fill={AMBER}><title>{`Week of ${p.label}: ${p.participationPct}% participation`}</title></path>
            {i === n - 1 ? <text x={x(i, n)} y={Math.max(9, top - 4)} textAnchor="middle" fontSize="10" fontWeight="700" fill={INK}>{p.participationPct}%</text> : null}
          </g>
        );
      })}
      <XLabels points={points} />
    </Frame>
  );
}

/** Weekly mood average as a single line with markers, fixed 1–5 scale. */
export function MoodChart({ points }: { points: WeekPoint[] }) {
  const known = points.map((p, i) => ({ ...p, i })).filter((p) => p.mood !== null);
  if (known.length === 0) return <Empty label="Mood" />;
  const n = points.length;
  const max = 5;
  // Break the line where weeks have no data — bridging a gap would invent it.
  const path = known.map((p, idx) => `${idx === 0 || known[idx - 1]!.i !== p.i - 1 ? 'M' : 'L'}${x(p.i, n).toFixed(1)},${yScale(p.mood!, max).toFixed(1)}`).join(' ');
  const last = known[known.length - 1]!;
  return (
    <Frame label="Weekly average mood on a 1 to 5 scale">
      <GridLines max={max} ticks={[1, 3, 5]} fmt={String} />
      <path d={path} fill="none" stroke={BLUE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {known.map((p) => (
        <g key={p.i}>
          <circle cx={x(p.i, n)} cy={yScale(p.mood!, max)} r="4" fill={BLUE} stroke="var(--bg-surface)" strokeWidth="2"><title>{`Week of ${p.label}: mood ${p.mood}/5`}</title></circle>
          {p.i === last.i ? <text x={x(p.i, n)} y={yScale(p.mood!, max) - 8} textAnchor="middle" fontSize="10" fontWeight="700" fill={INK}>{p.mood}</text> : null}
        </g>
      ))}
      <XLabels points={points} />
    </Frame>
  );
}

/** Blockers opened vs resolved per week — two series, grouped bars with a legend. */
export function BlockersChart({ points }: { points: WeekPoint[] }) {
  const max = Math.max(0, ...points.map((p) => Math.max(p.blockersOpened, p.blockersResolved)));
  if (max === 0) return <Empty label="Blockers" />;
  const scaleMax = Math.max(2, Math.ceil(max / 2) * 2);
  const n = points.length;
  const groupW = Math.min(26, (PLOT_W / n) * 0.62);
  const barW = (groupW - 2) / 2;
  return (
    <Frame label="Blockers opened and resolved per week">
      <GridLines max={scaleMax} ticks={[0, scaleMax / 2, scaleMax]} fmt={String} />
      {points.map((p, i) => {
        const cx = x(i, n);
        return (
          <g key={i}>
            <path d={roundedBarPath(cx - (barW + 2) / 2, barW, yScale(p.blockersOpened, scaleMax), M.top + PLOT_H)} fill={AMBER}><title>{`Week of ${p.label}: ${p.blockersOpened} opened`}</title></path>
            <path d={roundedBarPath(cx + (barW + 2) / 2, barW, yScale(p.blockersResolved, scaleMax), M.top + PLOT_H)} fill={BLUE}><title>{`Week of ${p.label}: ${p.blockersResolved} resolved`}</title></path>
          </g>
        );
      })}
      <g fontSize="9" fill={INK_MUTED}>
        <rect x={W - M.right - 118} y={M.top - 4} width="8" height="8" rx="2" fill={AMBER} />
        <text x={W - M.right - 106} y={M.top + 3}>opened</text>
        <rect x={W - M.right - 60} y={M.top - 4} width="8" height="8" rx="2" fill={BLUE} />
        <text x={W - M.right - 48} y={M.top + 3}>resolved</text>
      </g>
      <XLabels points={points} />
    </Frame>
  );
}

/** Element-wise average of several weekly series (weeks aligned by index). */
export function averageSeries(series: WeekPoint[][]): WeekPoint[] {
  const first = series[0];
  if (!first) return [];
  return first.map((_, i) => {
    const pts = series.map((s) => s[i]).filter((p): p is WeekPoint => !!p);
    const avg = (vals: (number | null)[]) => {
      const n = vals.filter((v): v is number => v !== null);
      return n.length ? Math.round((n.reduce((a, b) => a + b, 0) / n.length) * 10) / 10 : null;
    };
    return {
      label: first[i]!.label,
      participationPct: avg(pts.map((p) => p.participationPct)),
      mood: avg(pts.map((p) => p.mood)),
      blockersOpened: pts.reduce((a, p) => a + p.blockersOpened, 0),
      blockersResolved: pts.reduce((a, p) => a + p.blockersResolved, 0),
    };
  });
}
