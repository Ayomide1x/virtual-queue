/// <reference lib="dom" />
// How the app behaves for people using a keyboard, a screen reader, larger
// text, reduced motion, or Spanish — checked in a real browser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb, clickText, launch, newPage, pageErrors, startApp, waitForText, type TestApp } from './browser';
import { closeAll, sleep } from './helpers';

let app: TestApp;
let browser: Browser;

beforeAll(async () => {
  app = await startApp(await buildWeb());
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await app?.close();
  await closeAll();
});

async function newOffice() {
  const { body } = await app.api('POST', '/offices', { name: 'Behaviour Office', timezone: 'UTC' });
  return body as { officeId: string; staffKey: string };
}

const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { tag: el?.tagName, text: el?.innerText?.trim() ?? '', name: el?.getAttribute('name'), value: (el as HTMLInputElement | null)?.value, id: el?.id };
  });

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

async function joinPage(officeId: string, ticketId: string, opts: { lang?: string } = {}) {
  const page = await newPage(browser);
  if (opts.lang) await page.evaluateOnNewDocument((l) => localStorage.setItem('vq.lang', l), opts.lang);
  await page.goto(`${app.base}/o/${officeId}/join?ticket=${ticketId}`, { waitUntil: 'networkidle0' });
  return page;
}

describe('language', () => {
  it('switches the page language, sets <html lang>, and remembers the choice', async () => {
    const { officeId } = await newOffice();
    const page = await newPage(browser);
    await page.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    expect(await page.$eval('main h1', (h) => h.textContent)).toBe('Join the line');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');

    await page.select('header select', 'es');
    await waitForText(page, 'Únase a la fila');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('es');
    expect(await page.$eval('header select', (s) => s.getAttribute('aria-label') ?? (s.labels?.[0]?.textContent ?? ''))).toBe('Idioma');

    await page.reload({ waitUntil: 'networkidle0' });
    expect(await page.$eval('main h1', (h) => h.textContent)).toBe('Únase a la fila');
    // Staff pages stay English (and say so to screen readers) whatever the resident chose.
    await page.goto(`${app.base}/o/${officeId}/staff`, { waitUntil: 'networkidle0' });
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(pageErrors(page)).toEqual([]);
    await page.browserContext().close();
  });

  it('starts in the phone’s language the first time', async () => {
    const { officeId } = await newOffice();
    const page = await newPage(browser);
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es'] }));
    await page.goto(`${app.base}/o/${officeId}/book`, { waitUntil: 'networkidle0' });
    expect(await page.$eval('main h1', (h) => h.textContent)).toBe('Hacer una cita');
    await page.browserContext().close();
  });

  it('a resident who joins in Spanish gets a Spanish ticket, and switching language updates it', async () => {
    const { officeId } = await newOffice();
    const page = await newPage(browser);
    await page.evaluateOnNewDocument(() => localStorage.setItem('vq.lang', 'es'));
    await page.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    await page.type('#name', 'Lucía');
    await page.click('label:has(input[value=license])');
    await page.click('button[type=submit]');
    await waitForText(page, 'Ya está en la fila');
    const ticketId = await page.evaluate((id) => localStorage.getItem(`vq.ticket.${id}`), officeId);
    expect((await app.api('GET', `/o/${officeId}/tickets/${ticketId}`)).body.ticket.lang).toBe('es');

    await page.select('header select', 'en');
    await waitForText(page, 'you’re in line');
    const lang = await until(
      async () => (await app.api('GET', `/o/${officeId}/tickets/${ticketId}`)).body.ticket.lang,
      (l) => l === 'en',
    );
    expect(lang).toBe('en');
    await page.browserContext().close();
  });

  it('the lobby speaks each call in the called resident’s language, whatever the screen’s language', async () => {
    const { officeId, staffKey } = await newOffice();
    const page = await newPage(browser, { width: 1280 });
    // Capture speech instead of playing it.
    await page.evaluateOnNewDocument(() => {
      const spoken: Array<{ text: string; lang: string }> = [];
      (window as any).__spoken = spoken;
      Object.defineProperty(window, 'speechSynthesis', {
        value: { speak: (u: SpeechSynthesisUtterance) => spoken.push({ text: u.text, lang: u.lang }), getVoices: () => [], cancel: () => {} },
      });
    });
    await page.goto(`${app.base}/o/${officeId}/display`, { waitUntil: 'networkidle0' });
    await clickText(page, 'Enable sound announcements', 'button');
    const spoken = () => page.evaluate(() => (window as any).__spoken as Array<{ text: string; lang: string }>);

    const es = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Rosa', service: 'license', lang: 'es' })).body.ticket;
    await app.api('POST', `/o/${officeId}/counters/1/call`, {}, staffKey);
    await until(spoken, (s) => s.length === 1);
    const en = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Sam', service: 'license' })).body.ticket;
    await app.api('POST', `/o/${officeId}/counters/2/call`, {}, staffKey);
    const said = await until(spoken, (s) => s.length === 2);

    const digits = (n: string) => n.replace('-', ' ').split('').filter((c) => c.trim()).join(', ');
    expect(said).toEqual([
      { text: `Número ${digits(es.number)}, pase a Counter 1.`, lang: 'es-US' },
      { text: `Ticket ${digits(en.number)}, please go to Counter 2.`, lang: 'en-US' },
    ]);
    // The screen itself stays in its own language, and tells screen readers about the latest call.
    expect(await page.$eval('#now-serving', (h) => h.textContent)).toBe('Now Serving');
    expect(await page.$eval('p[role=status].sr-only', (p) => p.textContent)).toBe(`Ticket ${en.number}, please go to Counter 2.`);
    await page.browserContext().close();
  });
});

describe('screen readers', () => {
  it('announces when the resident moves up in line', async () => {
    const { officeId, staffKey } = await newOffice();
    for (const n of ['A', 'B']) await app.api('POST', `/o/${officeId}/tickets`, { name: n, service: 'license' });
    const me = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Me', service: 'license' })).body.ticket;
    const page = await joinPage(officeId, me.id);
    await waitForText(page, '2 people ahead');
    const live = () => page.$eval('main p[role=status].sr-only', (p) => p.textContent ?? '');
    expect(await live()).toBe(''); // nothing said just for opening the page

    await app.api('POST', `/o/${officeId}/counters/1/call`, {}, staffKey);
    expect(await until(live, (t) => t !== '')).toBe('You’re now number 2 in line. 1 person ahead of you.');
    await app.api('POST', `/o/${officeId}/counters/2/call`, {}, staffKey);
    expect(await until(live, (t) => t.includes('next'))).toBe('You’re next in line.');
    await page.browserContext().close();
  });

  it('says “it’s your turn” at once when called, and moves focus to it', async () => {
    const { officeId, staffKey } = await newOffice();
    const me = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Me', service: 'id', lang: 'es' })).body.ticket;
    const page = await joinPage(officeId, me.id, { lang: 'es' });
    await waitForText(page, 'Ya está en la fila');
    await app.api('POST', `/o/${officeId}/counters/4/call`, { service: 'id' }, staffKey);
    await page.waitForSelector('[role=alert]');
    expect(await page.$eval('[role=alert]', (p) => p.textContent)).toBe('Es su turno. Pase a Counter 4.');
    expect(await until(() => active(page), (a) => a.tag === 'H1')).toMatchObject({ tag: 'H1', text: 'Es su turno' });
    await page.browserContext().close();
  });
});

describe('keyboard', () => {
  it('skip link, then join the line with the keyboard alone (arrow keys pick the service)', async () => {
    const { officeId } = await newOffice();
    const page = await newPage(browser);
    await page.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });

    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ tag: 'A', text: 'Skip to main content' });
    const box = await page.evaluate(() => (document.activeElement as HTMLElement).getBoundingClientRect().width);
    expect(box).toBeGreaterThan(50); // visible once focused
    await page.keyboard.press('Enter');
    expect(await active(page)).toMatchObject({ tag: 'H1', text: 'Join the line' });

    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ id: 'name' });
    await page.keyboard.type('Kim');
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ tag: 'INPUT', name: 'service' });
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    expect(await active(page)).toMatchObject({ name: 'service', value: 'registration' });
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ tag: 'BUTTON', text: 'Get my ticket' });
    await page.keyboard.press('Enter');
    await waitForText(page, 'you’re in line');
    const ticketId = await page.evaluate((id) => localStorage.getItem(`vq.ticket.${id}`), officeId);
    expect((await app.api('GET', `/o/${officeId}/tickets/${ticketId}`)).body.ticket).toMatchObject({ name: 'Kim', service: 'registration' });
    await page.browserContext().close();
  });

  it('every stop on the page shows a visible focus ring', async () => {
    const { officeId } = await newOffice();
    const me = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Me', service: 'license' })).body.ticket;
    const page = await joinPage(officeId, me.id);
    await waitForText(page, 'Notify me');
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement === document.body)) break; // went past the last stop
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        // Visually hidden radio inputs show their ring on the card (label) around them.
        const shown = el.closest('label:has(input.sr-only)') ?? el;
        const cs = getComputedStyle(shown);
        return { what: `${el.tagName} ${el.innerText?.trim().slice(0, 20) || el.getAttribute('aria-label') || ''}`, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
      });
      seen.push(ring.what);
      expect(ring.style, `no focus ring on ${ring.what}`).not.toBe('none');
      expect(ring.width, `thin focus ring on ${ring.what}`).toBeGreaterThanOrEqual(2);
    }
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.some((s) => s.includes('Notify me'))).toBe(true);
    await page.browserContext().close();
  });

  it('Escape closes the “leave the line?” question and returns focus to the button', async () => {
    const { officeId } = await newOffice();
    const me = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Me', service: 'license' })).body.ticket;
    const page = await joinPage(officeId, me.id);
    await waitForText(page, 'Leave the line');
    await page.focus('button.btn-danger-outline');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=alertdialog]');
    expect(await active(page)).toMatchObject({ text: 'Keep my place' });
    await page.keyboard.press('Escape');
    await until(() => page.$('[role=alertdialog]'), (d) => d === null);
    expect(await active(page)).toMatchObject({ text: 'Leave the line' });
    expect((await app.api('GET', `/o/${officeId}/tickets/${me.id}`)).body.ticket.status).toBe('waiting');
    await page.browserContext().close();
  });

  it('staff priority menu: opens into its options, Escape closes it and returns focus', async () => {
    const { officeId, staffKey } = await newOffice();
    await app.api('POST', `/o/${officeId}/tickets`, { name: 'Pat', service: 'license' });
    const page = await newPage(browser, { width: 1280 });
    await page.evaluateOnNewDocument((id) => localStorage.setItem(`vq.staffCounter.${id}`, '1'), officeId);
    await page.goto(`${app.base}/o/${officeId}/staff#key=${staffKey}`, { waitUntil: 'networkidle0' });
    const star = await page.waitForSelector('button[aria-label="Priority options for D-001"]');
    await star!.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=group][id="priority-D-001"]');
    expect(await active(page)).toMatchObject({ tag: 'BUTTON', text: 'Disability' });
    await page.keyboard.press('Escape');
    await until(() => page.$('[role=group][id="priority-D-001"]'), (g) => g === null);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Priority options for D-001');
    await page.browserContext().close();
  });

  it('staff single-key shortcuts can be turned off (they clash with screen reader keys)', async () => {
    const { officeId, staffKey } = await newOffice();
    await app.api('POST', `/o/${officeId}/tickets`, { name: 'Pat', service: 'license' });
    const page = await newPage(browser, { width: 1280 });
    await page.evaluateOnNewDocument((id) => localStorage.setItem(`vq.staffCounter.${id}`, '1'), officeId);
    await page.goto(`${app.base}/o/${officeId}/staff#key=${staffKey}`, { waitUntil: 'networkidle0' });
    await clickText(page, 'Keyboard shortcuts', 'label');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press('n');
    await sleep(500);
    const counter1 = async () => (await app.api('GET', `/o/${officeId}/state`, undefined, staffKey)).body.counters[0].ticket;
    expect(await counter1()).toBeNull();
    await clickText(page, 'Keyboard shortcuts', 'label');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press('n');
    expect(await until(counter1, (t) => t !== null)).toMatchObject({ number: 'D-001' });
    await page.browserContext().close();
  });

  it('following a link moves focus to the new page’s heading', async () => {
    const { officeId, staffKey } = await newOffice();
    await app.api('PUT', `/o/${officeId}/settings`, { appointments: { enabled: true } }, staffKey);
    const page = await newPage(browser);
    await page.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    await clickText(page, 'Book an appointment', 'a');
    expect(await until(() => active(page), (a) => a.tag === 'H1')).toMatchObject({ tag: 'H1', text: 'Book an appointment' });
    await page.browserContext().close();
  });
});

describe('larger text and reduced motion', () => {
  it('“Larger text” scales the page and is remembered', async () => {
    const { officeId } = await newOffice();
    const page = await newPage(browser);
    await page.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    const rootSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    expect(await rootSize()).toBe('16px');
    await page.click('header button[aria-pressed]');
    expect(await page.$eval('header button[aria-pressed]', (b) => b.getAttribute('aria-pressed'))).toBe('true');
    expect(await rootSize()).toBe('20px');
    await page.reload({ waitUntil: 'networkidle0' });
    expect(await rootSize()).toBe('20px');
    // Nothing spills sideways on a phone at the larger size.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.click('header button[aria-pressed]');
    expect(await rootSize()).toBe('16px');
    await page.browserContext().close();
  });

  it('turns animations off when the device asks for reduced motion', async () => {
    const { officeId, staffKey } = await newOffice();
    const me = (await app.api('POST', `/o/${officeId}/tickets`, { name: 'Me', service: 'license' })).body.ticket;
    await app.api('POST', `/o/${officeId}/counters/1/call`, {}, staffKey);
    const page = await joinPage(officeId, me.id);
    await page.waitForSelector('.animate-pulse-ring');
    const anim = () => page.$eval('.animate-pulse-ring', (el) => ({ duration: getComputedStyle(el).animationDuration, count: getComputedStyle(el).animationIterationCount }));
    expect(await anim()).toEqual({ duration: '1.8s', count: 'infinite' });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    expect(await anim()).toEqual({ duration: '1e-05s', count: '1' });
    await page.browserContext().close();
  });
});

describe('analytics dashboard', () => {
  it('changes the date range and downloads CSV files', async () => {
    const { officeId, staffKey } = (await app.api('POST', '/offices', { name: 'Dash', timezone: 'UTC', seed: true })).body;
    const page = await newPage(browser, { width: 1280 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-dl-'));
    const cdp = await page.createCDPSession();
    // Downloads are allowed per browser context (each test page has its own).
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: page.browserContext().id });
    await page.goto(`${app.base}/o/${officeId}/analytics#key=${staffKey}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('figure svg');
    const pressed = () => page.$$eval('[aria-label="Quick ranges"] button', (bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent));
    expect(await pressed()).toEqual(['Last 30 days']);
    const perDayRows = () => page.$$eval('figure', (fs) => fs.find((f) => f.textContent?.includes('Tickets served per day'))!.querySelectorAll('tbody tr').length);
    expect(await perDayRows()).toBe(30);

    await clickText(page, 'Last 7 days', 'button');
    await until(perDayRows, (n) => n === 7);
    expect(await pressed()).toEqual(['Last 7 days']);
    expect(await page.$eval('main p[role=status]', (p) => p.textContent)).toMatch(/^Showing /);

    await clickText(page, 'Tickets', 'button');
    const file = await until(
      async () => fs.readdirSync(dir).find((f) => f.endsWith('.csv')),
      (f) => !!f,
    );
    expect(file).toMatch(new RegExp(`^tickets-${officeId}-\\d{4}-\\d{2}-\\d{2}-to-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    const csv = fs.readFileSync(path.join(dir, file!), 'utf8');
    expect(csv.split('\r\n')[0]).toContain('date,ticket,visit,service');
    expect(csv.split('\r\n').length).toBeGreaterThan(50);
    // On a phone the charts fit the screen (no sideways scrolling).
    await page.setViewport({ width: 390, height: 844 });
    await sleep(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors(page)).toEqual([]);
    await page.browserContext().close();
  });
});
