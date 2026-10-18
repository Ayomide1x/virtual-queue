import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { BarList, ChartFigure, COLORS, ColumnChart } from '../components/Charts';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { StaffGate } from '../components/StaffGate';
import { ApiError, officeApi } from '../lib/api';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { AnalyticsReport, Weekday } from '../types';

export default function Analytics() {
  const officeId = useOfficeId();
  return (
    <OfficeGate officeId={officeId}>
      {(data) => (
        <StaffGate officeId={officeId} officeName={data.office.name} title="Analytics">
          {(_staffKey, onForbidden) => <Dashboard key={officeId} officeId={officeId} officeName={data.office.name} onForbidden={onForbidden} />}
        </StaffGate>
      )}
    </OfficeGate>
  );
}

// ------------------------------------------------------------------ formatting

/** "4 min", "1 h 05 min", "45 s". */
function duration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const minutesAxis = (sec: number) => `${Math.round(sec / 60)}m`;
const pct = (x: number | null | undefined, digits = 1) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
const num = (n: number) => n.toLocaleString('en-US');
const DAY_NAMES: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;
const hourLong = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
const dateLabel = (d: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(Date.UTC(y, m - 1, day));
};
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const PRESETS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

// ------------------------------------------------------------------ dashboard

function Dashboard({ officeId, officeName, onForbidden }: { officeId: string; officeName: string; onForbidden: () => void }) {
  useTitle(`Analytics — ${officeName}`);
  const api = useMemo(() => officeApi(officeId), [officeId]);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(
    (from?: string, to?: string) => {
      setLoading(true);
      setError(null);
      api
        .analytics(from, to)
        .then((r) => {
          setReport(r);
          setRange({ from: r.from, to: r.to });
          setStatus(`Showing ${dateLabel(r.from, { month: 'long', day: 'numeric' })} to ${dateLabel(r.to, { month: 'long', day: 'numeric', year: 'numeric' })}.`);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 403) return onForbidden();
          setError(err instanceof ApiError ? err.message : 'Could not load analytics.');
        })
        .finally(() => setLoading(false));
    },
    [api, onForbidden],
  );

  useEffect(() => load(), [load]);

  const preset = (days: number) => report && load(shift(report.today, -(Math.min(days, report.retentionDays) - 1)), report.today);
  const activePreset = report && report.to === report.today ? PRESETS.find((p) => shift(report.today, -(p.days - 1)) === report.from)?.days : undefined;

  return (
    <div className="min-h-screen">
      <Header title="Analytics" office={officeName}>
        <nav className="flex items-center gap-4" aria-label="Staff">
          <Link to={`/o/${officeId}/staff`} className="rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
            ← Staff console
          </Link>
        </nav>
      </Header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl space-y-6 px-4 py-8 outline-none sm:px-6">
        <div>
          <h1 className="text-3xl font-extrabold text-navy-900">Analytics</h1>
          <p className="mt-1 text-lg text-muted">How the line has been running: waits, volume, no-shows and counter times.</p>
        </div>

        <section className="card flex flex-wrap items-end gap-x-6 gap-y-4 p-4" aria-label="Date range and export">
          <div role="group" aria-label="Quick ranges" className="flex flex-wrap gap-2">
            {PRESETS.filter((p) => !report || p.days <= report.retentionDays).map((p) => (
              <button
                key={p.days}
                type="button"
                aria-pressed={activePreset === p.days}
                onClick={() => preset(p.days)}
                className={`btn min-h-[44px] border-2 px-3 py-2 text-sm ${activePreset === p.days ? 'border-primary bg-primary text-white' : 'border-muted-light bg-white text-ink hover:bg-muted-lightest'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {report && <RangeForm report={report} range={range} onApply={load} />}
          {report && <ExportButtons api={api} from={report.from} to={report.to} />}
        </section>

        <p role="status" className="sr-only">
          {loading ? 'Loading…' : status}
        </p>
        {error && (
          <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
            {error}
          </p>
        )}

        {!report ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
            <Totals report={report} />
            {report.totals.joined === 0 ? (
              <p className="card p-6 text-center text-lg text-muted">No tickets in this date range yet.</p>
            ) : (
              <>
                <div className="grid gap-6 lg:grid-cols-2">
                  <WaitByHour report={report} />
                  <WaitByWeekday report={report} />
                </div>
                <PerDay report={report} />
                <div className="grid gap-6 lg:grid-cols-2">
                  <Services report={report} />
                  <Counters report={report} />
                </div>
              </>
            )}
            <p className="text-sm text-muted">
              Times are in the office’s time zone ({report.timezone}). Tickets count on the day they joined. Wait is from joining to being called; people who left
              before being called aren’t in the wait figures. History is kept for {report.retentionDays} days.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function RangeForm({ report, range, onApply }: { report: AnalyticsReport; range: { from?: string; to?: string }; onApply: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(range.from ?? report.from);
  const [to, setTo] = useState(range.to ?? report.to);
  useEffect(() => {
    setFrom(report.from);
    setTo(report.to);
  }, [report.from, report.to]);
  const earliest = shift(report.today, -(report.retentionDays - 1));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (from && to) onApply(from, to);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="range-from" className="mb-1 block text-sm font-semibold">
          From
        </label>
        <input id="range-from" type="date" required min={earliest} max={to || report.today} value={from} onChange={(e) => setFrom(e.target.value)} className="input min-h-[44px] w-auto" />
      </div>
      <div>
        <label htmlFor="range-to" className="mb-1 block text-sm font-semibold">
          To
        </label>
        <input id="range-to" type="date" required min={from || earliest} max={report.today} value={to} onChange={(e) => setTo(e.target.value)} className="input min-h-[44px] w-auto" />
      </div>
      <button type="submit" className="btn-primary min-h-[44px] px-4 py-2">
        Apply
      </button>
    </form>
  );
}

function ExportButtons({ api, from, to }: { api: ReturnType<typeof officeApi>; from: string; to: string }) {
  const [busy, setBusy] = useState<'events' | 'visits' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (kind: 'events' | 'visits') => {
    setBusy(kind);
    setError(null);
    try {
      const { blob, name } = await api.downloadCsv(kind, from, to);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the file.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="ml-auto flex flex-col gap-1">
      <span className="text-sm font-semibold">Export this range (CSV)</span>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-outline min-h-[44px] px-3 py-2 text-sm" onClick={() => download('visits')} disabled={!!busy}>
          {busy === 'visits' ? 'Preparing…' : 'Tickets'}
        </button>
        <button type="button" className="btn-outline min-h-[44px] px-3 py-2 text-sm" onClick={() => download('events')} disabled={!!busy}>
          {busy === 'events' ? 'Preparing…' : 'All events'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold text-danger-dark">
          {error}
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- sections

function Totals({ report }: { report: AnalyticsReport }) {
  const t = report.totals;
  const cards: Array<[string, string, string?]> = [
    ['Tickets', num(t.joined), `${num(t.left)} left before being called`],
    ['Served', num(t.served)],
    ['Average wait', duration(t.avgWaitSec)],
    ['Longest wait', duration(t.maxWaitSec)],
    ['No-show rate', pct(t.noShowRate), `${num(t.noShows)} of ${num(t.served + t.noShows)} called`],
    ['Average service time', duration(t.avgServiceSec)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      {cards.map(([label, value, note]) => (
        <div key={label} className="card px-4 py-3">
          <dt className="label">{label}</dt>
          <dd className="tabular mt-1 text-2xl font-extrabold text-navy-900">{value}</dd>
          {note && <dd className="text-xs text-muted">{note}</dd>}
        </div>
      ))}
    </dl>
  );
}

const WAIT_SERIES = [
  { key: 'avgWaitSec', label: 'Average wait', color: COLORS.primary },
  { key: 'maxWaitSec', label: 'Longest wait', color: COLORS.gold },
];

function WaitByHour({ report }: { report: AnalyticsReport }) {
  // Only the hours the office actually had people, with a little room either side.
  const busy = report.waitByHour.filter((h) => h.count > 0).map((h) => h.hour);
  const first = busy.length ? Math.max(0, Math.min(...busy) - 1) : 8;
  const last = busy.length ? Math.min(23, Math.max(...busy) + 1) : 17;
  const rows = report.waitByHour.filter((h) => h.hour >= first && h.hour <= last);
  const worst = [...rows].sort((a, b) => (b.avgWaitSec ?? -1) - (a.avgWaitSec ?? -1))[0];
  return (
    <ChartFigure
      title="Wait by hour of day"
      description="By the hour people joined"
      legend={WAIT_SERIES}
      summary={`Bar chart of average and longest wait for each hour from ${hourLong(first)} to ${hourLong(last)}. Longest average wait: ${duration(worst?.avgWaitSec)} for people joining at ${hourLong(worst?.hour ?? 0)}.`}
      table={{ columns: ['Hour', 'Tickets called', 'Average wait', 'Longest wait'], rows: rows.map((h) => [hourLong(h.hour), h.count, duration(h.avgWaitSec), duration(h.maxWaitSec)]) }}
    >
      {() => <ColumnChart data={rows} series={WAIT_SERIES} labelOf={(r) => hourLabel(r.hour)} format={minutesAxis} unit={60} labelEvery={rows.length > 12 ? 2 : 1} />}
    </ChartFigure>
  );
}

function WaitByWeekday({ report }: { report: AnalyticsReport }) {
  const rows = report.waitByWeekday;
  const worst = [...rows].sort((a, b) => (b.avgWaitSec ?? -1) - (a.avgWaitSec ?? -1))[0];
  return (
    <ChartFigure
      title="Wait by day of the week"
      legend={WAIT_SERIES}
      summary={`Bar chart of average and longest wait for each day of the week. Longest average wait: ${duration(worst.avgWaitSec)} on ${DAY_NAMES[worst.day]}s.`}
      table={{ columns: ['Day', 'Tickets called', 'Average wait', 'Longest wait'], rows: rows.map((d) => [DAY_NAMES[d.day], d.count, duration(d.avgWaitSec), duration(d.maxWaitSec)]) }}
    >
      {() => <ColumnChart data={rows} series={WAIT_SERIES} labelOf={(r) => DAY_NAMES[r.day].slice(0, 3)} format={minutesAxis} unit={60} />}
    </ChartFigure>
  );
}

function PerDay({ report }: { report: AnalyticsReport }) {
  const series = [
    { key: 'served', label: 'Served', color: COLORS.green },
    { key: 'noShows', label: 'No-show', color: COLORS.red },
    { key: 'left', label: 'Left before being called', color: COLORS.gray },
  ];
  const rows = report.perDay;
  const busiest = [...rows].sort((a, b) => b.served - a.served)[0];
  const days = rows.length;
  return (
    <ChartFigure
      title="Tickets served per day"
      description="With no-shows and people who left the line"
      legend={series}
      summary={`Stacked bar chart of tickets served per day over ${days} days, with no-shows and people who left. Busiest day: ${dateLabel(busiest.date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${busiest.served} served.`}
      table={{
        columns: ['Date', 'Joined', 'Served', 'No-shows', 'Left', 'No-show rate'],
        rows: rows.map((d) => [dateLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }), d.joined, d.served, d.noShows, d.left, d.served + d.noShows ? pct(d.noShows / (d.served + d.noShows)) : '—']),
      }}
    >
      {() => (
        <ColumnChart
          data={rows}
          series={series}
          stacked
          labelOf={(r) => dateLabel(r.date)}
          format={(v) => String(Math.round(v))}
          labelEvery={days > 60 ? 14 : days > 21 ? 7 : days > 10 ? 2 : 1}
          height={260}
        />
      )}
    </ChartFigure>
  );
}

function Services({ report }: { report: AnalyticsReport }) {
  const rows = report.services;
  return (
    <ChartFigure
      title="Busiest services"
      description="Tickets per service"
      summary={`Bar chart of tickets per service. ${rows
        .filter((s) => s.joined)
        .map((s) => `${s.name}: ${s.joined} (${pct(s.share, 0)})`)
        .join('; ')}.`}
      table={{
        columns: ['Service', 'Tickets', 'Share', 'Served', 'No-shows', 'Left', 'Average wait', 'Average service'],
        rows: rows.map((s) => [s.name, s.joined, pct(s.share, 0), s.served, s.noShows, s.left, duration(s.avgWaitSec), duration(s.avgServiceSec)]),
      }}
    >
      {() => <BarList rows={rows.map((s) => ({ label: s.name, value: s.joined, note: `${pct(s.share, 0)} · avg wait ${duration(s.avgWaitSec)}` }))} format={num} />}
    </ChartFigure>
  );
}

function Counters({ report }: { report: AnalyticsReport }) {
  const rows = report.counters;
  const used = rows.filter((c) => c.served > 0);
  const fastest = [...used].sort((a, b) => (a.avgServiceSec ?? 0) - (b.avgServiceSec ?? 0))[0];
  return (
    <ChartFigure
      title="Average service time per counter"
      description="Time at the counter, for people served"
      summary={`Bar chart of average service time per counter. ${used.map((c) => `${c.name}: ${duration(c.avgServiceSec)}`).join('; ')}.${fastest ? ` Quickest: ${fastest.name}.` : ''}`}
      table={{ columns: ['Counter', 'Served', 'Average service time'], rows: rows.map((c) => [c.name, c.served, duration(c.avgServiceSec)]) }}
    >
      {() => <BarList rows={rows.map((c) => ({ label: c.name, value: c.avgServiceSec ?? 0, note: `${num(c.served)} served` }))} format={duration} color={COLORS.navy} />}
    </ChartFigure>
  );
}
