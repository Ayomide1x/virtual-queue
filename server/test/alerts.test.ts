import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertSendError, LogEmailSender, emailHtml, emailText, maskEmail, type AlertMessage, type EmailSender, type PushSender, type PushSubscriptionJSON } from '../src/alerts/senders';
import { AlertService, type AlertServiceOptions } from '../src/alerts/service';
import { createApp } from '../src/app';
import type { OfficeConfig } from '../src/officeConfig';
import { OfficeStore } from '../src/offices';
import { CLAIM_JOBS } from '../src/scripts';
import { closeAll, connect, deleteUnder, keysUnder, sleep, uniqueRoot } from './helpers';

// ---------------------------------------------------------------- fakes

type Behavior = 'ok' | 'retry' | 'expired' | 'reject' | 'hang';

class FakePush implements PushSender {
  readonly enabled = true;
  readonly publicKey = 'test-public-key';
  sent: Array<{ endpoint: string; message: AlertMessage }> = [];
  attempts = 0;
  /** Behaviors for successive calls; after the list runs out, 'ok'. */
  script: Behavior[] = [];
  async send(sub: PushSubscriptionJSON, message: AlertMessage) {
    this.attempts++;
    const b = this.script.shift() ?? 'ok';
    if (b === 'hang') return new Promise<void>(() => {});
    if (b === 'retry') throw new AlertSendError('push failed (503)', true);
    if (b === 'expired') throw new AlertSendError('push subscription expired (410)', false, true);
    if (b === 'reject') throw new AlertSendError('push rejected (400)', false);
    this.sent.push({ endpoint: sub.endpoint, message });
  }
  types() {
    return this.sent.map((s) => s.message.title.split(':')[0]);
  }
}

class FakeEmail implements EmailSender {
  readonly mode = 'resend' as const;
  sent: Array<{ to: string; message: AlertMessage }> = [];
  script: Behavior[] = [];
  async send(to: string, message: AlertMessage) {
    const b = this.script.shift() ?? 'ok';
    if (b === 'retry') throw new AlertSendError('email rejected by Resend (500)', true);
    if (b === 'reject') throw new AlertSendError('email rejected by Resend (422)', false);
    this.sent.push({ to, message });
  }
}

const SUB: PushSubscriptionJSON = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};
const EMAIL = 'resident.person@example.org';

// ---------------------------------------------------------------- setup

const redis = connect();
const at = (hhmm: string) => new Date(`2026-03-04T${hhmm}:00Z`).getTime(); // Wednesday, UTC office
let root: string;
let clock: number;
let offices: OfficeStore;
let push: FakePush;
let email: FakeEmail;
let logs: string[];
let alerts: AlertService;
let officeId: string;
let config: OfficeConfig;

function makeAlerts(extra: Partial<AlertServiceOptions> = {}) {
  return new AlertService({
    redis,
    offices,
    push,
    email,
    baseUrl: 'https://queue.example.test',
    now: () => clock,
    backoffBaseMs: 1000,
    sendTimeoutMs: 100,
    log: (l) => logs.push(l),
    ...extra,
  });
}

const queue = () => offices.queue(officeId, config, { now: () => clock });
const book = () => offices.appointments(officeId, config, { now: () => clock });

async function line(n: number, service = 'license') {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await queue().join(`R${i}`, service)).ticket);
  return out;
}

/** Scan + deliver everything due, like the background job would. */
async function settle() {
  await alerts.scanOffice(officeId);
  await alerts.drain();
}

beforeEach(async () => {
  root = uniqueRoot();
  clock = at('09:00');
  offices = new OfficeStore(redis, { root, now: () => clock });
  push = new FakePush();
  email = new FakeEmail();
  logs = [];
  alerts = makeAlerts();
  const created = await offices.create({ name: 'Alert Office', timezone: 'UTC' });
  officeId = created.officeId;
  config = created.config;
});
afterEach(async () => {
  alerts.stop();
  await deleteUnder(redis, root);
});
afterAll(closeAll);

// ---------------------------------------------------------------- tests

describe('opting in', () => {
  it('stores push and email, returns only a masked address, and confirms on each channel', async () => {
    const [, , , , , me] = await line(6);
    const summary = await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    expect(summary).toEqual({ push: true, email: maskEmail(EMAIL) });
    expect(summary.email).not.toContain('resident');
    await alerts.drain();
    expect(push.types()).toEqual(['Alerts are on']);
    expect(email.sent.map((e) => e.message.title)).toEqual(['Alerts are on']);
    // Opting in again doesn't re-send the confirmation.
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    await alerts.drain();
    expect(push.sent).toHaveLength(1);
  });

  it('validates input and refuses ended or unknown tickets', async () => {
    const [t] = await line(1);
    await expect(alerts.setTicketContact(officeId, t.id, { email: 'not-an-email' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(alerts.setTicketContact(officeId, t.id, {})).rejects.toMatchObject({ code: 'invalid' });
    await expect(alerts.setTicketContact(officeId, t.id, { push: { endpoint: 'nope' } })).rejects.toMatchObject({ code: 'invalid' });
    // Arbitrary endpoints are refused, so the server never makes requests to URLs residents choose.
    await expect(alerts.setTicketContact(officeId, t.id, { push: { ...SUB, endpoint: 'https://evil.example.com/x' } })).rejects.toMatchObject({
      message: 'That push service isn’t supported.',
    });
    await expect(alerts.setTicketContact(officeId, '00000000-0000-4000-8000-000000000000', { email: EMAIL })).rejects.toMatchObject({ code: 'not_found' });
    await queue().leave(t.id);
    await expect(alerts.setTicketContact(officeId, t.id, { email: EMAIL })).rejects.toMatchObject({ code: 'not_active' });
  });
});

describe('when alerts are sent', () => {
  it('sends "3 people away" once, when the line reaches 3 ahead', async () => {
    const tickets = await line(6);
    const me = tickets[5]; // 5 ahead
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    await settle();
    push.sent = [];
    email.sent = [];

    await queue().callNext(1); // 4 ahead
    await settle();
    expect(push.sent).toHaveLength(0);

    await queue().callNext(2); // 3 ahead → alert
    await settle();
    expect(push.sent.map((s) => s.message)).toEqual([expect.objectContaining({ title: `Almost your turn: ${me.number}`, body: expect.stringMatching(/^3 people are ahead/) })]);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(EMAIL);

    await queue().callNext(3); // 2 ahead: no repeat
    await settle();
    await settle();
    expect(push.sent).toHaveLength(1);
  });

  it('jumping past 3 (people leaving) still alerts once', async () => {
    const tickets = await line(6);
    await alerts.setTicketContact(officeId, tickets[5].id, { push: SUB });
    await settle();
    push.sent = [];
    for (const t of tickets.slice(0, 4)) await queue().leave(t.id); // 5 → 1 ahead
    await settle();
    expect(push.types()).toEqual(['Almost your turn']);
    expect(push.sent[0].message.body).toMatch(/^1 person is ahead/);
  });

  it('opting in when already 3 or fewer away sends no "3 away" alert', async () => {
    const tickets = await line(3);
    await alerts.setTicketContact(officeId, tickets[2].id, { push: SUB });
    await settle();
    await queue().callNext(1);
    await settle();
    expect(push.types()).toEqual(['Alerts are on']);
  });

  it('sends "your turn" with the counter name, exactly once', async () => {
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    await settle();
    push.sent = [];
    email.sent = [];
    await queue().callNext(3);
    await settle();
    await queue().recall(3);
    await settle();
    await settle();
    expect(push.sent.map((s) => s.message)).toEqual([{ title: `It’s your turn: ${me.number}`, body: 'Please go to Counter 3 now.', url: expect.stringContaining(`/o/${officeId}/t/${me.id}`), tag: expect.any(String), lang: 'en', urgent: true }]);
    expect(email.sent.map((e) => e.message.body)).toEqual(['Please go to Counter 3 now.']);
  });

  it('a stale "3 away" is dropped if they were called before it went out', async () => {
    const tickets = await line(5);
    await alerts.setTicketContact(officeId, tickets[4].id, { push: SUB });
    await alerts.drain();
    push.sent = [];
    await queue().callNext(1); // 3 ahead
    await alerts.scanOffice(officeId); // queued, not yet delivered…
    for (let c = 2; c <= 4; c++) await queue().callNext(c);
    await queue().markServed(1);
    await queue().callNext(1); // …and they're called first
    await settle();
    expect(push.types()).toEqual(['It’s your turn']);
    expect(logs.some((l) => /skipped near via push.*no longer relevant/.test(l))).toBe(true);
  });

  it('two server processes scanning and sending at once never duplicate an alert', async () => {
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    await alerts.drain();
    push.sent = [];
    email.sent = [];
    const other = makeAlerts();
    await queue().callNext(1);
    await Promise.all([alerts.scanOffice(officeId), other.scanOffice(officeId), alerts.scanOffice(officeId), other.scanOffice(officeId)]);
    await Promise.all([alerts.drain(), other.drain(), alerts.drain(), other.drain()]);
    expect(push.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });
});

describe('delivery: retries, timeouts, expiry', () => {
  it('retries a failed send with exponential backoff, then delivers once', async () => {
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    push.script = ['retry', 'retry']; // confirmation fails twice, then succeeds
    await alerts.drain();
    expect(push.attempts).toBe(1);
    expect(push.sent).toHaveLength(0);

    clock += 500; // not due yet (~1s backoff)
    await alerts.drain();
    expect(push.attempts).toBe(1);

    clock += 1000; // ~1s → retry 1 fails, backs off ~2s
    await alerts.drain();
    expect(push.attempts).toBe(2);
    clock += 1500;
    await alerts.drain();
    expect(push.attempts).toBe(2);
    clock += 1500;
    await alerts.drain();
    expect(push.attempts).toBe(3);
    expect(push.sent).toHaveLength(1);
    expect(logs.filter((l) => /retry \d\/5 in/.test(l))).toHaveLength(2);
  });

  it('gives up after the maximum number of attempts', async () => {
    alerts = makeAlerts({ maxAttempts: 3 });
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    push.script = ['retry', 'retry', 'retry', 'retry'];
    for (let i = 0; i < 6; i++) {
      await alerts.drain();
      clock += 60_000;
    }
    expect(push.attempts).toBe(3);
    expect(push.sent).toHaveLength(0);
    expect(logs.some((l) => /gave up on confirm via push .* after 3 attempts/.test(l))).toBe(true);
    expect(await redis.zcard(`${root}alerts:jobs`)).toBe(0);
  });

  it('does not retry permanent rejections', async () => {
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    push.script = ['reject'];
    await alerts.drain();
    clock += 10 * 60_000;
    await alerts.drain();
    expect(push.attempts).toBe(1);
  });

  it('removes an expired push subscription and keeps email working', async () => {
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    push.script = ['expired'];
    await alerts.drain();
    expect(await alerts.getTicketContact(officeId, me.id)).toEqual({ push: false, email: maskEmail(EMAIL) });
    await queue().callNext(1);
    await settle();
    expect(push.attempts).toBe(1); // never tried again
    expect(email.sent.map((e) => e.message.title)).toEqual(['Alerts are on', `It’s your turn: ${me.number}`]);
  });

  it('a hung push service times out and is retried, and never slows the queue', async () => {
    const [me, other] = await line(2);
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    push.script = ['hang'];
    const worker = alerts.drain(); // send is stuck…
    const t0 = performance.now();
    await queue().callNext(1); // …but the queue carries on
    await queue().leave(other.id);
    const queueMs = performance.now() - t0;
    await worker;
    expect(queueMs).toBeLessThan(80);
    expect(logs.some((l) => /timed out after 100ms\); retry 1\//.test(l))).toBe(true);
    clock += 2000;
    await settle();
    expect(push.types().sort()).toEqual(['Alerts are on', 'It’s your turn']);
  });

  it('a job held by a crashed worker is picked up again after its lease', async () => {
    alerts = makeAlerts({ leaseMs: 30_000 });
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    // Another worker claims the job, then dies without finishing.
    const claimed = (await redis.eval(CLAIM_JOBS, 2, `${root}alerts:jobs`, `${root}alerts:processing`, String(clock), '30000', '10')) as string[];
    expect(claimed).toHaveLength(1);
    await alerts.drain();
    expect(push.sent).toHaveLength(0);
    clock += 31_000;
    await alerts.drain();
    expect(push.sent).toHaveLength(1);
  });
});

describe('privacy', () => {
  it('contact details are deleted the moment the ticket ends', async () => {
    for (const end of ['served', 'no_show', 'left'] as const) {
      const [me] = await line(1);
      await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
      if (end === 'left') await queue().leave(me.id);
      else {
        await queue().callNext(1);
        await (end === 'served' ? queue().markServed(1) : queue().markNoShow(1));
      }
      expect(await redis.exists(`${root}o:${officeId}:notify:${me.id}`)).toBe(0);
      expect(await redis.sismember(`${root}o:${officeId}:notifyidx`, me.id)).toBe(0);
      expect(await alerts.getTicketContact(officeId, me.id)).toEqual({ push: false, email: null });
    }
    // Queued alerts for ended tickets are dropped, not sent.
    push.sent = [];
    await alerts.drain();
    expect(push.sent).toHaveLength(0);
  });

  it('residents can turn alerts off per channel', async () => {
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    expect(await alerts.removeTicketContact(officeId, me.id, 'email')).toEqual({ push: true, email: null });
    expect(await alerts.removeTicketContact(officeId, me.id, 'push')).toEqual({ push: false, email: null });
    expect(await redis.sismember(`${root}o:${officeId}:notifyidx`, me.id)).toBe(0);
  });

  it('full email addresses never appear in logs', async () => {
    const logged: string[] = [];
    alerts = makeAlerts({ email: new LogEmailSender((l) => logged.push(l)) });
    const [me] = await line(1);
    await alerts.setTicketContact(officeId, me.id, { email: EMAIL });
    await queue().callNext(1);
    await settle();
    expect(logged).toHaveLength(2); // confirmation + your turn, logged instead of sent
    expect(logged.some((l) => l.includes('Would send “It’s your turn'))).toBe(true);
    for (const line of [...logged, ...logs]) expect(line).not.toContain(EMAIL);
    expect(logged.join('\n')).toContain(maskEmail(EMAIL));
  });

  it('masks addresses', () => {
    expect(maskEmail('ayomide@gmail.com')).toBe('a******@g****.com');
    expect(maskEmail('a@b.co')).toBe('a@b.co');
  });

  it('every alert key in an office expires with the office', async () => {
    const [me] = await line(2);
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    await settle();
    const keys = (await keysUnder(redis, `${root}o:${officeId}:`)).filter((k) => /notify|alerts/.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const k of keys) expect(await redis.ttl(k), k).toBeGreaterThan(0);
  });
});

describe('appointments', () => {
  it('sends a reminder 1 hour before, once', async () => {
    const appt = (await book().book({ name: 'Ana', service: 'id', date: '2026-03-04', time: '12:00' })).appointment;
    await alerts.setAppointmentContact(officeId, appt.id, { push: SUB, email: EMAIL });
    await alerts.drain();
    expect(push.types()).toEqual(['Reminder set']);

    clock = at('10:59');
    await alerts.drain();
    expect(push.sent).toHaveLength(1);
    clock = at('11:00');
    await alerts.drain();
    await alerts.drain();
    expect(push.sent.map((s) => s.message.title)).toEqual(['Reminder set', 'Appointment at 12:00 PM']);
    expect(push.sent[1].message.url).toBe(`https://queue.example.test/o/${officeId}/appointment/${appt.id}`);
    expect(email.sent.map((e) => e.message.title)).toEqual(['Reminder set', 'Appointment at 12:00 PM']);
  });

  it('no reminder if booked less than an hour ahead, or if cancelled', async () => {
    clock = at('11:30');
    const soon = (await book().book({ name: 'Soon', service: 'id', date: '2026-03-04', time: '12:00' })).appointment;
    await alerts.setAppointmentContact(officeId, soon.id, { push: SUB });
    const later = (await book().book({ name: 'Later', service: 'id', date: '2026-03-04', time: '15:00' })).appointment;
    await alerts.setAppointmentContact(officeId, later.id, { email: EMAIL });
    await book().cancel(later.id);
    expect(await redis.exists(`${root}o:${officeId}:notify:appt:${later.id}`)).toBe(0); // deleted with the booking
    await alerts.drain();
    clock = at('16:00');
    await alerts.drain();
    expect(push.types()).toEqual(['Reminder set']);
    // The confirmation queued for the cancelled booking was dropped, not sent.
    expect(email.sent).toEqual([]);
  });

  it('missed appointments lose their contact details', async () => {
    const appt = (await book().book({ name: 'Mo', service: 'id', date: '2026-03-04', time: '10:00' })).appointment;
    await alerts.setAppointmentContact(officeId, appt.id, { email: EMAIL });
    clock = at('10:30');
    await book().day('2026-03-04'); // runs the missed sweep
    expect(await redis.exists(`${root}o:${officeId}:notify:appt:${appt.id}`)).toBe(0);
  });

  it('after check-in, the same contact gets "your turn"', async () => {
    const appt = (await book().book({ name: 'Ana', service: 'id', date: '2026-03-04', time: '10:00' })).appointment;
    await alerts.setAppointmentContact(officeId, appt.id, { push: SUB });
    await alerts.drain();
    clock = at('10:00');
    const ticketId = await book().checkIn(appt.id);
    await alerts.afterCheckIn(officeId, ticketId);
    expect(await alerts.getTicketContact(officeId, ticketId)).toEqual({ push: true, email: null });
    expect(await redis.exists(`${root}o:${officeId}:notify:appt:${appt.id}`)).toBe(0);
    await queue().callNext(2);
    await settle();
    expect(push.types()).toEqual(['Reminder set', 'It’s your turn']);
    expect(push.sent[1].message.body).toBe('Please go to Counter 2 now.');
  });
});

describe('end to end through the API', () => {
  it('a staff action triggers an alert in the background via pub/sub', async () => {
    const subscriber = connect();
    const app = createApp({ redis, subscriber, offices, publicUrl: null, lanIp: null, alerts: makeAlerts({ now: Date.now }) });
    const service = makeAlerts({ now: Date.now });
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
    const created = await (await fetch(`${base}/offices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as any;
    const join = await (
      await fetch(`${base}/o/${created.officeId}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ana', service: 'id' }) })
    ).json() as any;
    const opt = await fetch(`${base}/o/${created.officeId}/tickets/${join.ticket.id}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ push: SUB, email: EMAIL }),
    });
    expect(await opt.json()).toEqual({ push: true, email: maskEmail(EMAIL) });
    const meta = await (await fetch(`${base}/meta`)).json() as any;
    expect(meta.alerts).toEqual({ push: { enabled: true, publicKey: 'test-public-key' }, email: { enabled: true, mode: 'resend' } });

    const t0 = performance.now();
    const call = await fetch(`${base}/o/${created.officeId}/counters/1/call`, { method: 'POST', headers: { 'x-staff-key': created.staffKey, 'content-type': 'application/json' }, body: '{}' });
    expect(call.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(500);

    // The server's scan (triggered over pub/sub) queues the alert; a worker delivers it.
    for (let i = 0; i < 40 && !push.sent.some((s) => s.message.title.startsWith('It’s your turn')); i++) {
      await sleep(50);
      await service.drain();
    }
    expect(push.sent.map((s) => s.message.title)).toContain(`It’s your turn: ${join.ticket.number}`);

    // Opting in through another office's URL is refused.
    const other = await (await fetch(`${base}/offices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as any;
    const cross = await fetch(`${base}/o/${other.officeId}/tickets/${join.ticket.id}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(cross.status).toBe(404);
    const manifest = await (await fetch(`${base}/o/${created.officeId}/manifest.webmanifest?start=/o/${created.officeId}/t/${join.ticket.id}`)).json() as any;
    expect(manifest).toMatchObject({ start_url: `/o/${created.officeId}/t/${join.ticket.id}`, display: 'standalone' });
    const bad = await (await fetch(`${base}/o/${created.officeId}/manifest.webmanifest?start=https://evil.example.com`)).json() as any;
    expect(bad.start_url).toBe(`/o/${created.officeId}/join`);
    const plain = await (await fetch(`${base}/o/${created.officeId}/manifest.webmanifest`)).json() as any;
    expect(plain.start_url).toBe(`/o/${created.officeId}/join`);
    app.io.close();
  });
});

describe('in the resident’s language', () => {
  it('sends ticket alerts in Spanish to a resident who joined in Spanish', async () => {
    const ahead = await line(4);
    const me = (await queue().join('Lucía', 'license', { lang: 'es' })).ticket;
    await alerts.setTicketContact(officeId, me.id, { push: SUB, email: EMAIL });
    await alerts.drain();
    expect(push.sent[0].message).toMatchObject({ title: 'Alertas activadas', lang: 'es' });

    await queue().callNext(1, 'license');
    await settle();
    expect(push.sent[1].message).toMatchObject({ title: `Ya casi es su turno: ${me.number}`, body: expect.stringContaining('Hay 3 personas antes que usted'), lang: 'es' });

    for (const c of [2, 3, 4]) await queue().callNext(c, 'license');
    await queue().markServed(1);
    await queue().callNext(1, 'license');
    await settle();
    expect(push.sent.at(-1)!.message).toMatchObject({ title: `Es su turno: ${me.number}`, body: 'Pase a Counter 1 ahora.' });
    // Email uses the same language, in its template too.
    const mail = email.sent.at(-1)!.message;
    expect(mail.title).toBe(`Es su turno: ${me.number}`);
    expect(emailHtml(mail)).toContain('<html lang="es">');
    expect(emailHtml(mail)).toContain('Abrir');
    expect(emailText(mail)).toContain('Su dirección se borra');
    expect(ahead).toHaveLength(4);
  });

  it('follows a language change made after joining', async () => {
    await line(4);
    const me = (await queue().join('Sam', 'license')).ticket;
    await alerts.setTicketContact(officeId, me.id, { push: SUB });
    await alerts.drain();
    expect(push.sent[0].message.title).toBe('Alerts are on');
    await queue().setLanguage(me.id, 'es');
    await queue().callNext(1, 'license');
    await settle();
    expect(push.sent.at(-1)!.message.title).toBe(`Ya casi es su turno: ${me.number}`);
  });

  it('reminds in Spanish with Spanish times and dates, and the checked-in ticket keeps the language', async () => {
    const appt = (await book().book({ name: 'Ana', service: 'id', date: '2026-03-04', time: '12:00', lang: 'es' })).appointment;
    expect(appt.lang).toBe('es');
    await alerts.setAppointmentContact(officeId, appt.id, { push: SUB });
    await alerts.drain();
    expect(push.sent[0].message).toMatchObject({ title: 'Recordatorio programado', body: expect.stringContaining('miércoles, 4 de marzo') });
    clock = at('11:00');
    await alerts.drain();
    await alerts.drain();
    expect(push.sent[1].message.title).toMatch(/^Cita a las 12:00\s?p\.\s?m\.$/);

    clock = at('11:55');
    const ticketId = await book().checkIn(appt.id);
    expect((await queue().getTicketView(ticketId))!.ticket.lang).toBe('es');
  });
});
