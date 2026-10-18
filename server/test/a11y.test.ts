/// <reference lib="dom" />
// axe-core accessibility checks on every page, in every state a person can
// see it in: English, Spanish, and with "Larger text" on (resident pages).

import type { Browser, Page } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb, expectNoAxeViolations, launch, newPage, pageErrors, startApp, waitForText, type TestApp } from './browser';
import { closeAll } from './helpers';

let app: TestApp;
let browser: Browser;
let office: { officeId: string; staffKey: string };
let closedOffice: { officeId: string; staffKey: string };
let historyOffice: { officeId: string; staffKey: string };
let ids: { waiting: string; called: string; served: string; appt: string; cancelledAppt: string };

const o = (p: string) => `/o/${office.officeId}${p}`;

async function bookable(officeId: string) {
  const { body } = await app.api('GET', `/o/${officeId}/slots?service=id`);
  const day = body.days.find((d: any) => d.slots.some((s: any) => s.remaining > 0));
  return { date: day.date, time: day.slots.find((s: any) => s.remaining > 0).time };
}

beforeAll(async () => {
  const webDist = await buildWeb();
  app = await startApp(webDist);
  browser = await launch();

  office = (await app.api('POST', '/offices', { name: 'Access City Services', timezone: 'UTC' })).body;
  const key = office.staffKey;
  await app.api('PUT', o('/settings'), { appointments: { enabled: true } }, key);
  // A line with people in it, one of them priority.
  for (const n of ['Ana', 'Ben', 'Cy']) await app.api('POST', o('/tickets'), { name: n, service: 'license' });
  await app.api('POST', o('/priority'), { number: 'D-002', reason: 'senior' }, key);
  const waiting = (await app.api('POST', o('/tickets'), { name: 'Dee', service: 'license' })).body.ticket.id;
  // Someone being served at a counter, and someone already done.
  const served = (await app.api('POST', o('/tickets'), { name: 'Eve', service: 'registration' })).body.ticket.id;
  await app.api('POST', o('/counters/2/call'), { service: 'registration' }, key);
  await app.api('POST', o('/counters/2/served'), {}, key);
  const called = (await app.api('POST', o('/tickets'), { name: 'Fay', service: 'id' })).body.ticket.id;
  await app.api('POST', o('/counters/1/call'), { service: 'id' }, key);
  await app.api('POST', o('/counters/1/recall'), {}, key); // shows the "calling you again" line too

  const slot = await bookable(office.officeId);
  const appt = (await app.api('POST', o('/appointments'), { name: 'Gus', service: 'id', ...slot })).body.appointment.id;
  const cancelledAppt = (await app.api('POST', o('/appointments'), { name: 'Hal', service: 'id', ...slot })).body.appointment.id;
  await app.api('POST', o(`/appointments/${cancelledAppt}/cancel`));
  ids = { waiting, called, served, appt, cancelledAppt };

  // An office with weeks of (seeded) history, for the analytics dashboard.
  historyOffice = (await app.api('POST', '/offices', { name: 'History Office', timezone: 'UTC', seed: true })).body;

  // An office whose hours mean it's closed now.
  closedOffice = (await app.api('POST', '/offices', { name: 'Closed Office', timezone: 'UTC' })).body;
  const nowUtc = new Date();
  const hh = String((nowUtc.getUTCHours() + 2) % 24).padStart(2, '0');
  const day = { open: `${hh}:00`, close: `${hh}:30` };
  const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, day]));
  await app.api('PUT', `/o/${closedOffice.officeId}/settings`, { hoursEnabled: true, hours }, closedOffice.staffKey);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await closeAll();
});

interface PageState {
  name: string;
  path: () => string;
  /** Resident pages are also checked in Spanish and with larger text. */
  resident?: boolean;
  staff?: boolean;
  iphone?: boolean;
  width?: number;
  /** Text to wait for before checking (English, or a selector with `css:`). */
  ready: string;
  /** Put the page in the state to check (open a menu, etc.). */
  act?: (page: Page) => Promise<void>;
}

const states: PageState[] = [
  { name: 'home', path: () => '/', ready: 'css:h1' },
  {
    name: 'home, office just created',
    path: () => '/',
    ready: 'css:form button[type=submit]',
    act: async (p) => {
      await p.click('form button[type=submit]');
      await p.waitForSelector('input[value*="#key="]');
    },
  },
  { name: 'join form', path: () => o('/join'), resident: true, ready: 'css:#name' },
  { name: 'join form with an error', path: () => o('/join'), resident: true, ready: 'css:#name', act: async (p) => p.click('button[type=submit]') },
  { name: 'join, line closed', path: () => `/o/${closedOffice.officeId}/join`, resident: true, ready: 'css:main h1' },
  { name: 'waiting with alerts card', path: () => o(`/join?ticket=${ids.waiting}`), resident: true, ready: 'css:[aria-labelledby^="alerts-"]' },
  {
    name: 'waiting, email form open',
    path: () => o(`/join?ticket=${ids.waiting}`),
    resident: true,
    ready: 'css:[aria-labelledby^="alerts-"]',
    act: async (p) => {
      await p.click('[aria-labelledby^="alerts-"] button.underline');
      await p.waitForSelector('#alert-email');
    },
  },
  { name: 'waiting on iPhone (install guide)', path: () => o(`/join?ticket=${ids.waiting}`), resident: true, iphone: true, ready: 'css:ol li' },
  {
    name: 'waiting, leave question open',
    path: () => o(`/join?ticket=${ids.waiting}`),
    resident: true,
    ready: 'css:[aria-labelledby^="alerts-"]',
    act: async (p) => {
      await p.click('button.btn-danger-outline');
      await p.waitForSelector('[role=alertdialog]');
    },
  },
  { name: 'called', path: () => o(`/join?ticket=${ids.called}`), resident: true, ready: 'css:main h1[tabindex]' },
  { name: 'served', path: () => o(`/join?ticket=${ids.served}`), resident: true, ready: 'css:main .card h1' },
  {
    name: 'book, all steps shown',
    path: () => o('/book'),
    resident: true,
    ready: 'css:input[name=service]',
    act: async (p) => {
      await p.click('label:has(input[name=service][value=id])');
      await p.waitForSelector('input[name=time]:not([disabled])');
      await p.click('label:has(input[name=time]:not([disabled]))');
      await p.waitForSelector('#book-name');
    },
  },
  { name: 'book, appointments off', path: () => `/o/${closedOffice.officeId}/book`, resident: true, ready: 'css:main h1' },
  { name: 'appointment booked', path: () => o(`/appointment/${ids.appt}`), resident: true, ready: 'css:main h1' },
  {
    name: 'appointment, cancel question open',
    path: () => o(`/appointment/${ids.appt}`),
    resident: true,
    ready: 'css:main h1',
    act: async (p) => {
      await p.click('button.btn-danger-outline');
      await p.waitForSelector('[role=alertdialog]');
    },
  },
  { name: 'appointment cancelled', path: () => o(`/appointment/${ids.cancelledAppt}`), resident: true, ready: 'css:main h1' },
  { name: 'appointment not found', path: () => o('/appointment/00000000-0000-4000-8000-000000000000'), resident: true, ready: 'css:main h1' },
  { name: 'lobby display', path: () => o('/display'), resident: true, width: 1280, ready: 'css:#now-serving' },
  { name: 'lobby display, closed', path: () => `/o/${closedOffice.officeId}/display`, resident: true, width: 1280, ready: 'css:#now-serving' },
  { name: 'office not found', path: () => '/o/nosuchoffice1/join', resident: true, ready: 'css:main h1' },
  { name: 'staff, key prompt', path: () => o('/staff'), ready: 'css:main h1' },
  {
    name: 'staff, wrong key',
    path: () => o('/staff'),
    ready: 'css:#staff-key',
    act: async (p) => {
      await p.type('#staff-key', 'not-the-key');
      await p.click('button[type=submit]');
      await p.waitForSelector('[role=alert]');
    },
  },
  { name: 'staff, counter picker', path: () => o(`/staff#key=${office.staffKey}`), ready: 'css:main h1' },
  {
    name: 'staff console, priority menu open',
    path: () => o(`/staff#key=${office.staffKey}`),
    staff: true,
    width: 1280,
    ready: 'css:main h1',
    act: async (p) => {
      await p.waitForSelector('button[aria-label^="Priority options"]');
      await p.click('button[aria-label^="Priority options"]');
      await p.waitForSelector('[role=group][id^=priority-]');
    },
  },
  { name: 'analytics dashboard', path: () => `/o/${historyOffice.officeId}/analytics#key=${historyOffice.staffKey}`, width: 1280, ready: 'css:figure svg' },
  {
    name: 'analytics dashboard, numbers tables open (phone)',
    path: () => `/o/${historyOffice.officeId}/analytics#key=${historyOffice.staffKey}`,
    ready: 'css:figure svg',
    act: async (p) => {
      for (const d of await p.$$('figure details summary')) await d.click();
    },
  },
  { name: 'staff settings', path: () => o(`/settings#key=${office.staffKey}`), width: 1280, ready: 'css:main h1' },
  { name: 'staff appointments day view', path: () => o(`/appointments#key=${office.staffKey}`), width: 1280, ready: 'css:main h1' },
];

async function open(state: PageState, variant: { lang?: 'es'; large?: boolean }) {
  const page = await newPage(browser, { iphone: state.iphone, width: state.width });
  await page.evaluateOnNewDocument((v) => {
    if (v.lang) localStorage.setItem('vq.lang', v.lang);
    if (v.large) localStorage.setItem('vq.textSize', 'large');
    localStorage.setItem('vq.staffShortcuts', 'on');
  }, variant);
  if (state.staff) {
    // Staff consoles remember their counter; start with one chosen.
    await page.evaluateOnNewDocument((id) => localStorage.setItem(`vq.staffCounter.${id}`, '3'), office.officeId);
  }
  await page.goto(app.base + state.path(), { waitUntil: 'networkidle0' });
  if (state.ready.startsWith('css:')) await page.waitForSelector(state.ready.slice(4), { timeout: 8000 });
  else await waitForText(page, state.ready);
  await state.act?.(page);
  return page;
}

async function check(state: PageState, variant: { lang?: 'es'; large?: boolean }, label: string) {
  const page = await open(state, variant);
  await expectNoAxeViolations(page, label);
  if (variant.lang) expect(await page.evaluate(() => document.documentElement.lang)).toBe(state.resident ? variant.lang : 'en');
  expect(pageErrors(page), `JavaScript errors on ${label}`).toEqual([]);
  await page.browserContext().close();
}

describe('axe: no accessibility violations', () => {
  for (const state of states) {
    it(state.name, () => check(state, {}, state.name));
    if (state.resident) {
      it(`${state.name} (Spanish)`, () => check(state, { lang: 'es' }, `${state.name} (Spanish)`));
      it(`${state.name} (larger text)`, () => check(state, { large: true }, `${state.name} (larger text)`));
    }
  }
});
