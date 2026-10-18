import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CopyField } from '../components/CopyField';
import { Header } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { StaffGate } from '../components/StaffGate';
import { ApiError, officeApi } from '../lib/api';
import { rememberOffice } from '../lib/myOffices';
import { officeLinks, publicBase } from '../lib/urls';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import { WEEKDAYS, type OfficeConfig, type OfficeResponse, type Weekday } from '../types';

const DAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

// Form rows carry a local key so React can track rows that don't have ids yet.
interface ServiceRow {
  key: string;
  id?: string;
  name: string;
  code: string;
  minutes: string;
}
interface CounterRow {
  key: string;
  id?: number;
  name: string;
}
interface Form {
  name: string;
  timezone: string;
  services: ServiceRow[];
  counters: CounterRow[];
  hoursEnabled: boolean;
  hours: Record<Weekday, { enabled: boolean; open: string; close: string }>;
  appointments: { enabled: boolean; slotMinutes: string; capacity: string; daysAhead: string; checkInEarlyMin: string; checkInLateMin: string };
}

const APPT_FIELDS = [
  { key: 'slotMinutes', label: 'Slot length (minutes)', min: 5, max: 240 },
  { key: 'capacity', label: 'Bookings per slot, per service', min: 1, max: 50 },
  { key: 'daysAhead', label: 'Days ahead residents can book', min: 1, max: 60 },
  { key: 'checkInEarlyMin', label: 'Check-in opens (minutes before)', min: 0, max: 120 },
  { key: 'checkInLateMin', label: 'Check-in closes (minutes after)', min: 0, max: 120 },
] as const;

let rowSeq = 0;
const rowKey = () => `row${++rowSeq}`;

function toForm(c: OfficeConfig): Form {
  return {
    name: c.name,
    timezone: c.timezone,
    services: c.services.map((s) => ({ key: rowKey(), id: s.id, name: s.name, code: s.code, minutes: String(Math.round((s.defaultServiceSec / 60) * 10) / 10) })),
    counters: c.counters.map((x) => ({ key: rowKey(), id: x.id, name: x.name })),
    hoursEnabled: c.hoursEnabled,
    hours: Object.fromEntries(
      WEEKDAYS.map((d) => [d, c.hours[d] ? { enabled: true, ...c.hours[d]! } : { enabled: false, open: '09:00', close: '17:00' }]),
    ) as Form['hours'],
    appointments: {
      enabled: c.appointments.enabled,
      slotMinutes: String(c.appointments.slotMinutes),
      capacity: String(c.appointments.capacity),
      daysAhead: String(c.appointments.daysAhead),
      checkInEarlyMin: String(c.appointments.checkInEarlyMin),
      checkInLateMin: String(c.appointments.checkInLateMin),
    },
  };
}

function toSettings(f: Form) {
  return {
    name: f.name,
    timezone: f.timezone,
    services: f.services.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, code: s.code, defaultServiceSec: Math.round(Number(s.minutes) * 60) })),
    counters: f.counters.map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name })),
    hoursEnabled: f.hoursEnabled,
    hours: Object.fromEntries(WEEKDAYS.map((d) => [d, f.hours[d].enabled ? { open: f.hours[d].open, close: f.hours[d].close } : null])),
    appointments: {
      enabled: f.appointments.enabled,
      slotMinutes: Number(f.appointments.slotMinutes),
      capacity: Number(f.appointments.capacity),
      daysAhead: Number(f.appointments.daysAhead),
      checkInEarlyMin: Number(f.appointments.checkInEarlyMin),
      checkInLateMin: Number(f.appointments.checkInLateMin),
    },
  };
}

/** Problems we can point at before sending anything to the server. */
function validate(f: Form): string[] {
  const problems: string[] = [];
  if (!f.name.trim()) problems.push('Enter an office name.');
  if (f.services.length === 0) problems.push('Add at least one service.');
  if (f.counters.length === 0) problems.push('Add at least one counter.');
  f.services.forEach((s, i) => {
    if (!s.name.trim()) problems.push(`Service ${i + 1} needs a name.`);
    if (!/^[A-Za-z]$/.test(s.code)) problems.push(`“${s.name || `Service ${i + 1}`}” needs a single ticket letter.`);
    const min = Number(s.minutes);
    if (!Number.isFinite(min) || min < 0.5 || min > 240) problems.push(`“${s.name || `Service ${i + 1}`}” needs a service time between 0.5 and 240 minutes.`);
  });
  const letters = f.services.map((s) => s.code.toUpperCase()).filter(Boolean);
  const dupes = [...new Set(letters.filter((l, i) => letters.indexOf(l) !== i))];
  dupes.forEach((l) => problems.push(`More than one service uses the letter ${l}.`));
  f.counters.forEach((c, i) => !c.name.trim() && problems.push(`Counter ${i + 1} needs a name.`));
  for (const field of APPT_FIELDS) {
    const v = Number(f.appointments[field.key]);
    if (!Number.isInteger(v) || v < field.min || v > field.max) problems.push(`${field.label}: enter a whole number from ${field.min} to ${field.max}.`);
  }
  if (f.hoursEnabled) {
    WEEKDAYS.forEach((d) => {
      const h = f.hours[d];
      if (h.enabled && !(h.open < h.close)) problems.push(`${DAY_NAMES[d]}: closing time must be after opening time.`);
    });
  }
  return problems;
}

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'];
  }
})();

export default function Settings() {
  const officeId = useOfficeId();
  return (
    <OfficeGate officeId={officeId}>
      {(data) => (
        <StaffGate officeId={officeId} officeName={data.office.name} title="Settings">
          {(staffKey) => <SettingsScreen key={officeId} officeId={officeId} staffKey={staffKey} meta={data} />}
        </StaffGate>
      )}
    </OfficeGate>
  );
}

function SettingsScreen({ officeId, staffKey, meta }: { officeId: string; staffKey: string; meta: OfficeResponse }) {
  const api = useMemo(() => officeApi(officeId), [officeId]);
  const [saved, setSaved] = useState<OfficeConfig | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useTitle(`Settings — ${saved?.name ?? meta.office.name}`);

  useEffect(() => {
    api
      .getSettings()
      .then((c) => {
        setSaved(c);
        setForm(toForm(c));
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load settings.'));
  }, [api]);

  const dirty = form && saved ? JSON.stringify(toSettings(form)) !== JSON.stringify(toSettings(toForm(saved))) : false;
  const problems = form ? validate(form) : [];

  const update = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setStatus(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || problems.length) return;
    setSaving(true);
    setStatus(null);
    try {
      const next = await api.saveSettings(toSettings(form));
      setSaved(next);
      setForm(toForm(next));
      rememberOffice(officeId, next.name);
      setStatus({ kind: 'success', text: 'Settings saved. All screens have been updated.' });
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const { base } = publicBase(meta);
  const links = officeLinks(base, officeId, staffKey);

  return (
    <div className="min-h-screen pb-28">
      <Header title="Settings" office={saved?.name ?? meta.office.name}>
        <Link to={`/o/${officeId}/staff`} className="rounded px-2 py-1 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
          ← Staff console
        </Link>
      </Header>
      <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-extrabold text-navy-900">Office settings</h1>
        {loadError && (
          <p role="alert" className="rounded-md border-l-8 border-danger-dark bg-danger-light p-4 font-semibold text-danger-dark">
            {loadError}
          </p>
        )}
        {!form && !loadError && (
          <p className="text-muted" role="status">
            Loading settings…
          </p>
        )}
        {form && (
          <form id="settings-form" onSubmit={save} className="space-y-6" noValidate>
            <Section title="Office">
              <Field label="Office name" htmlFor="name">
                <input id="name" value={form.name} maxLength={60} onChange={(e) => update({ name: e.target.value })} className="input" />
              </Field>
              <Field label="Time zone" htmlFor="tz" hint="Opening hours and “today” statistics use this time zone.">
                <select id="tz" value={form.timezone} onChange={(e) => update({ timezone: e.target.value })} className="input">
                  {(TIME_ZONES.includes(form.timezone) ? TIME_ZONES : [form.timezone, ...TIME_ZONES]).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>
            </Section>

            <Section title="Services" description="What residents can join a line for. The ticket letter prefixes their number (e.g. D-042). The default time is used for wait estimates until real service times are recorded.">
              <div className="space-y-3">
                <div className="hidden grid-cols-[1fr_88px_120px_44px] gap-3 px-1 text-sm font-semibold text-muted sm:grid">
                  <span>Name</span>
                  <span>Letter</span>
                  <span>Default (min)</span>
                  <span className="sr-only">Remove</span>
                </div>
                {form.services.map((s, i) => (
                  <div key={s.key} className="grid grid-cols-[1fr_72px] gap-3 rounded-md border border-muted-lighter p-3 sm:grid-cols-[1fr_88px_120px_44px] sm:border-0 sm:p-0">
                    <input
                      aria-label={`Service ${i + 1} name`}
                      value={s.name}
                      maxLength={40}
                      placeholder="e.g. Passports"
                      onChange={(e) => update({ services: form.services.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)) })}
                      className="input"
                    />
                    <input
                      aria-label={`Service ${i + 1} ticket letter`}
                      value={s.code}
                      maxLength={1}
                      onChange={(e) => update({ services: form.services.map((x) => (x.key === s.key ? { ...x, code: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') } : x)) })}
                      className="input text-center font-bold uppercase"
                    />
                    <input
                      aria-label={`Service ${i + 1} default service time in minutes`}
                      type="number"
                      inputMode="decimal"
                      min={0.5}
                      max={240}
                      step={0.5}
                      value={s.minutes}
                      onChange={(e) => update({ services: form.services.map((x) => (x.key === s.key ? { ...x, minutes: e.target.value } : x)) })}
                      className="input"
                    />
                    <RemoveButton label={`Remove ${s.name || `service ${i + 1}`}`} disabled={form.services.length <= 1} onClick={() => update({ services: form.services.filter((x) => x.key !== s.key) })} />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-outline"
                  disabled={form.services.length >= 8}
                  onClick={() => {
                    const used = new Set(form.services.map((s) => s.code));
                    const letter = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').find((l) => !used.has(l)) ?? '';
                    update({ services: [...form.services, { key: rowKey(), name: '', code: letter, minutes: '5' }] });
                  }}
                >
                  + Add service
                </button>
                <p className="text-sm text-muted">A service can only be removed when nobody is waiting in it.</p>
              </div>
            </Section>

            <Section title="Counters" description="Names appear on the lobby display and in residents’ “go to …” alert.">
              <div className="space-y-3">
                {form.counters.map((c, i) => (
                  <div key={c.key} className="grid grid-cols-[1fr_44px] gap-3">
                    <input
                      aria-label={`Counter ${i + 1} name`}
                      value={c.name}
                      maxLength={30}
                      placeholder="e.g. Window A"
                      onChange={(e) => update({ counters: form.counters.map((x) => (x.key === c.key ? { ...x, name: e.target.value } : x)) })}
                      className="input"
                    />
                    <RemoveButton label={`Remove ${c.name || `counter ${i + 1}`}`} disabled={form.counters.length <= 1} onClick={() => update({ counters: form.counters.filter((x) => x.key !== c.key) })} />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-outline"
                  disabled={form.counters.length >= 20}
                  onClick={() => update({ counters: [...form.counters, { key: rowKey(), name: `Counter ${form.counters.length + 1}` }] })}
                >
                  + Add counter
                </button>
              </div>
            </Section>

            <Section title="Opening hours" description="Outside these hours the join page and lobby display say the line is closed. Staff can still serve people already waiting.">
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={form.hoursEnabled} onChange={(e) => update({ hoursEnabled: e.target.checked })} className="h-5 w-5 accent-primary" />
                <span className="font-semibold">Only allow joining during opening hours</span>
              </label>
              {!form.hoursEnabled && <p className="text-sm text-muted">Currently residents can join at any time.</p>}
              <fieldset disabled={!form.hoursEnabled} className={`mt-2 divide-y divide-muted-lighter rounded-md border border-muted-lighter ${form.hoursEnabled ? '' : 'opacity-50'}`}>
                <legend className="sr-only">Hours by day</legend>
                {WEEKDAYS.map((d) => {
                  const h = form.hours[d];
                  const set = (patch: Partial<typeof h>) => update({ hours: { ...form.hours, [d]: { ...h, ...patch } } });
                  return (
                    <div key={d} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <label className="flex w-36 cursor-pointer items-center gap-3 font-semibold">
                        <input type="checkbox" checked={h.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-5 w-5 accent-primary" />
                        {DAY_NAMES[d]}
                      </label>
                      {h.enabled ? (
                        <span className="flex items-center gap-2">
                          <input type="time" aria-label={`${DAY_NAMES[d]} opening time`} value={h.open} onChange={(e) => set({ open: e.target.value })} className="input w-auto" />
                          <span className="text-muted">to</span>
                          <input type="time" aria-label={`${DAY_NAMES[d]} closing time`} value={h.close} onChange={(e) => set({ close: e.target.value })} className="input w-auto" />
                        </span>
                      ) : (
                        <span className="text-muted">Closed</span>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            </Section>
          </form>
        )}

        {form && (
          <Section
            title="Appointments"
            description="Residents can book a time slot. Slots come from the weekly hours above, even if joining isn’t limited to opening hours. Checked-in appointments go ahead of walk-ins who joined after their slot time."
          >
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={form.appointments.enabled}
                onChange={(e) => update({ appointments: { ...form.appointments, enabled: e.target.checked } })}
                className="h-5 w-5 accent-primary"
                form="settings-form"
              />
              <span className="font-semibold">Let residents book appointments online</span>
            </label>
            <div className={`grid gap-4 sm:grid-cols-2 ${form.appointments.enabled ? '' : 'opacity-50'}`}>
              {APPT_FIELDS.map((field) => (
                <Field key={field.key} label={field.label} htmlFor={`appt-${field.key}`}>
                  <input
                    id={`appt-${field.key}`}
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    max={field.max}
                    disabled={!form.appointments.enabled}
                    value={form.appointments[field.key]}
                    onChange={(e) => update({ appointments: { ...form.appointments, [field.key]: e.target.value } })}
                    className="input"
                    form="settings-form"
                  />
                </Field>
              ))}
            </div>
            <p className="text-sm text-muted">
              Residents book at <span className="font-mono">/o/…/book</span>. A link appears on the join page. Staff see each day under <em>Appointments</em> in the staff console.
            </p>
          </Section>
        )}

        <Section title="Share links">
          <CopyField label="Staff console link" value={links.staff} secret hint="Contains the staff key. Anyone with it can run the queue and change settings." />
          <CopyField label="Lobby display link" value={links.display} />
          <CopyField label="Resident join link" value={links.join} />
        </Section>

        <DemoData api={api} />
      </main>

      {form && (
        <div className="fixed inset-x-0 bottom-0 border-t border-muted-lighter bg-white/95 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <div className="min-w-0 flex-1 text-sm" aria-live="polite">
              {status ? (
                <span role={status.kind === 'error' ? 'alert' : 'status'} className={`font-semibold ${status.kind === 'error' ? 'text-danger-dark' : 'text-success-darker'}`}>
                  {status.text}
                </span>
              ) : problems.length ? (
                <span className="font-semibold text-danger-dark">{problems[0]}</span>
              ) : dirty ? (
                <span className="font-semibold text-ink">You have unsaved changes.</span>
              ) : (
                <span className="text-muted">All changes saved.</span>
              )}
            </div>
            {dirty && saved && (
              <button type="button" className="btn-secondary" onClick={() => (setForm(toForm(saved)), setStatus(null))} disabled={saving}>
                Discard
              </button>
            )}
            <button type="submit" form="settings-form" className="btn-primary" disabled={!dirty || saving || problems.length > 0}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card space-y-4 p-6" aria-label={title}>
      <div>
        <h2 className="text-xl font-bold text-navy-900">{title}</h2>
        {description && <p className="mt-1 text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block font-bold">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="col-span-2 inline-flex min-h-[48px] items-center justify-center rounded-md border-2 border-muted-lighter text-muted hover:border-danger-dark hover:text-danger-dark disabled:opacity-40 sm:col-span-1"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
      </svg>
      <span className="ml-2 sm:hidden">Remove</span>
    </button>
  );
}

function DemoData({ api }: { api: ReturnType<typeof officeApi> }) {
  const [confirm, setConfirm] = useState<'seed' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      if (confirm === 'seed') await api.seed();
      else await api.reset();
      setMessage({ kind: 'success', text: confirm === 'seed' ? 'Sample residents loaded.' : 'All queues cleared.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'That didn’t work. Please try again.' });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  return (
    <Section title="Demo data" description="Fill the lines with sample residents and a morning of history, for demos and training. This replaces everyone currently in line.">
      <div className="flex flex-wrap items-center gap-3">
        {confirm ? (
          <>
            <span className="font-semibold">{confirm === 'seed' ? 'Replace everyone in line with sample residents?' : 'Remove everyone from every line and reset today’s stats?'}</span>
            <button type="button" className="btn-primary" onClick={run} disabled={busy}>
              {busy ? 'Working…' : 'Yes, continue'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn-outline" onClick={() => (setConfirm('seed'), setMessage(null))}>
              Fill with sample residents
            </button>
            <button type="button" className="btn-danger-outline" onClick={() => (setConfirm('reset'), setMessage(null))}>
              Clear all queues
            </button>
          </>
        )}
      </div>
      {message && (
        <p role="status" className={`font-semibold ${message.kind === 'error' ? 'text-danger-dark' : 'text-success-darker'}`}>
          {message.text}
        </p>
      )}
    </Section>
  );
}
