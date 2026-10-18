import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

// Small, dependency-free SVG charts. Every chart is a <figure> with a caption,
// a one-line text summary for screen readers (role="img" + aria-label), and the
// exact numbers in a table that anyone can open.

export interface Series {
  key: string;
  label: string;
  /** Fill color: all have at least 3:1 contrast against white (WCAG 1.4.11). */
  color: string;
}

export const COLORS = {
  primary: '#005ea2',
  gold: '#936f38',
  green: '#008817',
  red: '#b50909',
  gray: '#565c65',
  navy: '#112f4e',
};

/** Width of an element, kept up to date, so charts draw crisp at any size. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A round axis maximum and ~4 tick values. */
function niceScale(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function ChartFigure({
  title,
  description,
  summary,
  legend,
  table,
  children,
}: {
  title: string;
  description?: string;
  /** What the chart shows, in words (read by screen readers instead of the drawing). */
  summary: string;
  legend?: Series[];
  table: { columns: string[]; rows: Array<Array<string | number>> };
  children: (labelledBy: string) => ReactNode;
}) {
  const id = useId();
  return (
    <figure className="card min-w-0 p-5" aria-labelledby={`${id}-title`}>
      <figcaption>
        <h2 id={`${id}-title`} className="text-lg font-bold text-navy-900">
          {title}
        </h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </figcaption>
      {legend && legend.length > 1 && (
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-hidden="true">
          {legend.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3" role="img" aria-label={summary}>
        {children(`${id}-title`)}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-semibold text-primary underline underline-offset-4">Show the numbers</summary>
        {/* Focusable, so keyboard users can scroll a long table. */}
        <div className="mt-2 max-h-80 overflow-auto" tabIndex={0} role="region" aria-label={`${title}: numbers`}>
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                {table.columns.map((c, i) => (
                  <th key={c} scope="col" className={`border-b-2 border-muted-lighter px-2 py-1 font-semibold ${i ? 'text-right' : ''}`}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {table.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-muted-lighter">
                  {r.map((cell, ci) =>
                    ci === 0 ? (
                      <th key={ci} scope="row" className="px-2 py-1 font-normal">
                        {cell}
                      </th>
                    ) : (
                      <td key={ci} className="px-2 py-1 text-right">
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/**
 * Vertical bars per category. `stacked` piles series on top of each other
 * (parts of a whole); otherwise they stand side by side.
 */
export function ColumnChart<T extends object>({
  data,
  series,
  labelOf,
  format,
  stacked = false,
  height = 240,
  labelEvery = 1,
  unit = 1,
}: {
  data: T[];
  series: Series[];
  labelOf: (row: T, i: number) => string;
  format: (v: number) => string;
  stacked?: boolean;
  height?: number;
  /** Show every nth category label (long ranges). */
  labelEvery?: number;
  /** Size of one axis unit in data values, e.g. 60 for seconds shown as minutes, so ticks fall on round minutes. */
  unit?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(320);
  const pad = { top: 10, right: 8, bottom: 28, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const val = (row: T, key: string) => Number((row as Record<string, unknown>)[key] ?? 0) || 0;
  const max = Math.max(0, ...data.map((row) => (stacked ? series.reduce((a, s) => a + val(row, s.key), 0) : Math.max(...series.map((s) => val(row, s.key))))));
  const ticks = niceScale(max / unit).map((t) => t * unit);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const band = innerW / Math.max(1, data.length);
  const gap = Math.min(8, band * 0.2);
  const barW = stacked ? band - gap : (band - gap) / series.length;

  return (
    // overflow-hidden: the drawing must never widen its container (it's sized from it).
    <div ref={ref} className="w-full min-w-0 overflow-hidden">
      <svg width={width} height={height} aria-hidden="true" focusable="false" className="block overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="#dfe1e2" />
            <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="12" fill="#565c65">
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((row, i) => {
          const x0 = pad.left + i * band + gap / 2;
          let acc = 0;
          return (
            <g key={i}>
              {series.map((s, si) => {
                const v = val(row, s.key);
                if (!v) return null;
                const x = stacked ? x0 : x0 + si * barW;
                const yTop = stacked ? y(acc + v) : y(v);
                const h = stacked ? y(acc) - y(acc + v) : y(0) - y(v);
                if (stacked) acc += v;
                return (
                  <rect key={s.key} x={x} y={yTop} width={Math.max(1, barW - (stacked ? 0 : 1))} height={Math.max(0, h)} fill={s.color} rx={1.5}>
                    <title>{`${labelOf(row, i)} · ${s.label}: ${format(v)}`}</title>
                  </rect>
                );
              })}
              {i % labelEvery === 0 && (
                <text x={pad.left + i * band + band / 2} y={height - pad.bottom + 16} textAnchor="middle" fontSize="12" fill="#565c65">
                  {labelOf(row, i)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="#a9aeb1" />
      </svg>
    </div>
  );
}

/** Horizontal bars, one per row, with the value written at the end. */
export function BarList({ rows, color = COLORS.primary, format }: { rows: Array<{ label: string; value: number; note?: string }>; color?: string; format: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3" aria-hidden="true">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-semibold">{r.label}</span>
            <span className="tabular shrink-0 text-muted">
              {format(r.value)}
              {r.note ? ` · ${r.note}` : ''}
            </span>
          </div>
          <div className="mt-1 h-3 rounded-full bg-muted-lightest">
            <div className="h-3 rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: color, minWidth: r.value ? 4 : 0 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
