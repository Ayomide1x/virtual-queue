/// <reference lib="dom" />
// A ticket survives being opened in a different browsing context, such as an
// iPhone Home Screen app, which starts with its own, empty storage. The ticket
// travels in the page address (/o/:office/t/:ticket) and in the manifest's
// start_url, which the server writes into the page itself.
//
// Separate browser contexts stand in for Safari and the Home Screen app here.
// That guards against regressions; it can't prove what iOS does with the
// manifest. That needs a real iPhone.

import type { Browser, Page } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb, expectNoAxeViolations, launch, newPage, pageErrors, startApp, waitForText, type TestApp } from './browser';
import { closeAll } from './helpers';

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

async function officeWithTicket(name = 'Dana') {
  const { body: office } = await app.api('POST', '/offices', { name: 'Link Office', timezone: 'UTC' });
  const { body: joined } = await app.api('POST', `/o/${office.officeId}/tickets`, { name, service: 'license' });
  return { officeId: office.officeId as string, staffKey: office.staffKey as string, ticketId: joined.ticket.id as string };
}

async function ticketIn(officeId: string, name: string) {
  return (await app.api('POST', `/o/${officeId}/tickets`, { name, service: 'license' })).body.ticket.id as string;
}

/**
 * A page that reports itself as an installed Home Screen app on an iPhone, the
 * way iOS does: navigator.standalone and the display-mode media query.
 */
async function homeScreenApp(): Promise<Page> {
  const page = await newPage(browser, { iphone: true });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    const original = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q.includes('display-mode: standalone') ? ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList) : original(q);
  });
  return page;
}

/** Put a ticket in this page's storage, as if it had been joined on this device before. */
async function storeTicket(page: Page, officeId: string, ticketId: string) {
  await page.goto(`${app.base}/api/meta`);
  await page.evaluate((o, id) => localStorage.setItem(`vq.ticket.${o}`, id), officeId, ticketId);
}

const stored = (page: Page, officeId: string) => page.evaluate((o) => localStorage.getItem(`vq.ticket.${o}`), officeId);

/** Full page loads (in-app route changes don't fetch a document). */
function countLoads(page: Page): string[] {
  const docs: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document' && !r.url().includes('/api/')) docs.push(new URL(r.url()).pathname);
  });
  return docs;
}

const manifestHref = (html: string) => /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');

describe('the page as served', () => {
  it('puts a manifest whose start_url is the ticket address into the ticket page’s HTML', async () => {
    const { officeId, ticketId } = await officeWithTicket();
    const res = await fetch(`${app.base}/o/${officeId}/t/${ticketId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const href = manifestHref(await res.text());
    expect(href).toBe(`/api/o/${officeId}/manifest.webmanifest?start=${encodeURIComponent(`/o/${officeId}/t/${ticketId}`)}`);
    const manifest = await (await fetch(`${app.base}${href}`)).json();
    expect(manifest).toMatchObject({ start_url: `/o/${officeId}/t/${ticketId}`, scope: '/', display: 'standalone' });
  });

  it('gives the join page a manifest that opens the join page', async () => {
    const { officeId } = await officeWithTicket();
    const href = manifestHref(await (await fetch(`${app.base}/o/${officeId}/join`)).text());
    const manifest = await (await fetch(`${app.base}${href}`)).json();
    expect(manifest.start_url).toBe(`/o/${officeId}/join`);
  });

  it('adds no manifest to staff pages or malformed ticket addresses', async () => {
    const { officeId } = await officeWithTicket();
    for (const p of [`/o/${officeId}/staff`, `/o/${officeId}/t/not-a-ticket`, `/o/${officeId}/t/${'0'.repeat(8)}"><script>`, '/']) {
      const html = await (await fetch(`${app.base}${p}`)).text();
      expect(manifestHref(html), p).toBeUndefined();
    }
  });

  it('never lets start_url point at another office or another site', async () => {
    const a = await officeWithTicket();
    const b = await officeWithTicket();
    const get = async (start: string) => (await (await fetch(`${app.base}/api/o/${a.officeId}/manifest.webmanifest?start=${encodeURIComponent(start)}`)).json()).start_url;
    expect(await get(`/o/${b.officeId}/t/${b.ticketId}`)).toBe(`/o/${a.officeId}/join`);
    expect(await get('https://evil.example.com/')).toBe(`/o/${a.officeId}/join`);
    expect(await get(`/o/${a.officeId}/appointment/${a.ticketId}`)).toBe(`/o/${a.officeId}/appointment/${a.ticketId}`);
  });

  it('redirects old ?ticket= links (alerts already sent, icons already installed) to the ticket address', async () => {
    const { officeId, ticketId } = await officeWithTicket();
    const res = await fetch(`${app.base}/o/${officeId}/join?ticket=${ticketId}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/o/${officeId}/t/${ticketId}`);
    // Junk in ?ticket= just shows the join page.
    expect((await fetch(`${app.base}/o/${officeId}/join?ticket=junk`, { redirect: 'manual' })).status).toBe(200);
  });
});

describe('in a browser', () => {
  it('joining loads the ticket address as a fresh page, and that address opens the ticket in empty storage', async () => {
    const { officeId } = await officeWithTicket('Someone ahead');
    // "Safari": scan, fill in the form, get a ticket.
    const safari = await newPage(browser, { iphone: true });
    await safari.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    await safari.type('#name', 'Ana');
    await safari.click('label:has(input[value=license])');
    await Promise.all([safari.waitForNavigation({ waitUntil: 'networkidle0' }), safari.click('button[type=submit]')]);
    await waitForText(safari, 'Hi Ana, you’re in line.');
    const ticketId = await safari.evaluate((id) => localStorage.getItem(`vq.ticket.${id}`), officeId);
    expect(safari.url()).toBe(`${app.base}/o/${officeId}/t/${ticketId}`);

    // What a freshly loaded page offers "Add to Home Screen": its manifest's start_url.
    const href = await safari.$eval('link[rel=manifest]', (l) => l.getAttribute('href'));
    expect(await safari.$$eval('link[rel=manifest]', (ls) => ls.length)).toBe(1);
    const startUrl = (await (await fetch(`${app.base}${href}`)).json()).start_url;
    expect(startUrl).toBe(`/o/${officeId}/t/${ticketId}`);

    // "The Home Screen app": its own, empty storage, opened at start_url.
    const homeScreen = await newPage(browser, { iphone: true });
    await homeScreen.goto(`${app.base}${startUrl}`, { waitUntil: 'networkidle0' });
    await waitForText(homeScreen, 'Hi Ana, you’re in line.');
    expect(await homeScreen.evaluate((id) => localStorage.getItem(`vq.ticket.${id}`), officeId)).toBe(ticketId);
    expect([...pageErrors(safari), ...pageErrors(homeScreen)]).toEqual([]);
  });

  it('an old ?ticket= link opens the ticket, at its new address', async () => {
    const { officeId, ticketId } = await officeWithTicket('Lee');
    const page = await newPage(browser);
    await page.goto(`${app.base}/o/${officeId}/join?ticket=${ticketId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Lee, you’re in line.');
    expect(page.url()).toBe(`${app.base}/o/${officeId}/t/${ticketId}`);
  });

  it('a returning resident who scans the lobby code again is taken to their ticket', async () => {
    const { officeId, ticketId } = await officeWithTicket('Sam');
    const page = await newPage(browser);
    await page.goto(`${app.base}/o/${officeId}/t/${ticketId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Sam, you’re in line.');
    await page.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Sam, you’re in line.');
    expect(page.url()).toBe(`${app.base}/o/${officeId}/t/${ticketId}`);
  });

  it('a ticket that has ended lands on the join form once, without reloading in a loop', async () => {
    const { officeId, ticketId } = await officeWithTicket('Kim');
    await app.api('DELETE', `/o/${officeId}/tickets/${ticketId}`);
    const page = await newPage(browser);
    const documents: string[] = []; // full page loads (in-app route changes don't fetch a document)
    page.on('request', (r) => {
      if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
    });
    await page.goto(`${app.base}/o/${officeId}/t/${ticketId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Get my ticket');
    await new Promise((r) => setTimeout(r, 1000));
    expect(new URL(page.url()).pathname).toBe(`/o/${officeId}/join`);
    expect(documents).toEqual([`/o/${officeId}/t/${ticketId}`]); // one load; the move to /join is in-app
    expect(await page.evaluate((id) => localStorage.getItem(`vq.ticket.${id}`), officeId)).toBeNull();
  });
});

describe('which ticket wins', () => {
  it('in Safari, an opened ticket link wins over the ticket stored on the device', async () => {
    const { officeId } = await officeWithTicket();
    const older = await ticketIn(officeId, 'Stored');
    const linked = await ticketIn(officeId, 'Linked');
    const page = await newPage(browser, { iphone: true });
    await storeTicket(page, officeId, older);
    await page.goto(`${app.base}/o/${officeId}/t/${linked}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Linked, you’re in line.');
    expect(page.url()).toBe(`${app.base}/o/${officeId}/t/${linked}`);
    expect(await stored(page, officeId)).toBe(linked); // the device now follows the ticket it opened
  });

  it('in Safari, a link to a ticket that has ended falls back to the stored one, with a fresh page load', async () => {
    const { officeId } = await officeWithTicket();
    const mine = await ticketIn(officeId, 'Still here');
    const ended = await ticketIn(officeId, 'Gone');
    await app.api('DELETE', `/o/${officeId}/tickets/${ended}`);
    const page = await newPage(browser, { iphone: true });
    await storeTicket(page, officeId, mine);
    const loads = countLoads(page);
    await page.goto(`${app.base}/o/${officeId}/t/${ended}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Still here, you’re in line.');
    expect(page.url()).toBe(`${app.base}/o/${officeId}/t/${mine}`);
    expect(loads).toEqual([`/o/${officeId}/t/${ended}`, `/o/${officeId}/t/${mine}`]);
    // The page Safari would add to the Home Screen now carries the ticket shown.
    const href = await page.$eval('link[rel=manifest]', (l) => l.getAttribute('href'));
    expect((await (await fetch(`${app.base}${href}`)).json()).start_url).toBe(`/o/${officeId}/t/${mine}`);
  });

  it('in the Home Screen app, a ticket joined inside the app wins over the frozen start_url ticket', async () => {
    const { officeId } = await officeWithTicket();
    const installedWith = await ticketIn(officeId, 'Installed');
    const joinedInApp = await ticketIn(officeId, 'Newer');
    const page = await homeScreenApp();
    await storeTicket(page, officeId, joinedInApp);
    const loads = countLoads(page);
    await page.goto(`${app.base}/o/${officeId}/t/${installedWith}`, { waitUntil: 'networkidle0' }); // the icon's start_url
    await waitForText(page, 'Hi Newer, you’re in line.');
    expect(new URL(page.url()).pathname).toBe(`/o/${officeId}/t/${joinedInApp}`);
    expect(loads).toEqual([`/o/${officeId}/t/${installedWith}`]); // moved in-app, no reload
    expect(await stored(page, officeId)).toBe(joinedInApp);
  });

  it('in the Home Screen app, an ended stored ticket falls back to the start_url ticket', async () => {
    const { officeId } = await officeWithTicket();
    const installedWith = await ticketIn(officeId, 'From the icon');
    const ended = await ticketIn(officeId, 'Old');
    await app.api('DELETE', `/o/${officeId}/tickets/${ended}`);
    const page = await homeScreenApp();
    await storeTicket(page, officeId, ended);
    await page.goto(`${app.base}/o/${officeId}/t/${installedWith}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi From the icon, you’re in line.');
    expect(new URL(page.url()).pathname).toBe(`/o/${officeId}/t/${installedWith}`);
    expect(await stored(page, officeId)).toBe(installedWith);
  });

  it('a ticket that ends while it’s being watched is shown as ended, not swapped for another', async () => {
    const { officeId } = await officeWithTicket();
    const other = await ticketIn(officeId, 'Other');
    const watched = await ticketIn(officeId, 'Watched');
    const page = await newPage(browser);
    await storeTicket(page, officeId, other);
    await page.goto(`${app.base}/o/${officeId}/t/${watched}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Watched, you’re in line.');
    await app.api('DELETE', `/o/${officeId}/tickets/${watched}`); // e.g. left from another tab
    await waitForText(page, 'You have left the line.');
    expect(new URL(page.url()).pathname).toBe(`/o/${officeId}/join`);
  });
});

describe('a Home Screen app added before joining', () => {
  it('explains that a ticket joined in Safari stays in Safari', async () => {
    const { officeId } = await officeWithTicket();
    const app_ = await homeScreenApp();
    await app_.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    await waitForText(app_, 'Already joined in Safari?');
    await expectNoAxeViolations(app_, 'join page in the Home Screen app');
    const safari = await newPage(browser, { iphone: true });
    await safari.goto(`${app.base}/o/${officeId}/join`, { waitUntil: 'networkidle0' });
    expect(await safari.evaluate(() => document.body.innerText)).not.toContain('Already joined in Safari?');
  });
});

describe('Copy ticket link', () => {
  it('copies the ticket address and says so', async () => {
    const { officeId } = await officeWithTicket();
    const id = await ticketIn(officeId, 'Copier');
    const page = await newPage(browser);
    await page.browserContext().overridePermissions(app.base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await page.goto(`${app.base}/o/${officeId}/t/${id}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi Copier, you’re in line.');
    const button = await page.waitForSelector('xpath/.//button[contains(., "Copy ticket link")]');
    await button!.click();
    await waitForText(page, 'Link copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${app.base}/o/${officeId}/t/${id}`);
    expect(await page.evaluate(() => document.body.innerText)).toContain('Anyone with this link can see your place');
    await expectNoAxeViolations(page, 'ticket page after copying the link');
  });

  it('shows the link to copy by hand when the clipboard is unavailable', async () => {
    const { officeId } = await officeWithTicket();
    const id = await ticketIn(officeId, 'No clipboard');
    const page = await newPage(browser);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
    });
    await page.goto(`${app.base}/o/${officeId}/t/${id}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hi No clipboard, you’re in line.');
    await (await page.waitForSelector('xpath/.//button[contains(., "Copy ticket link")]'))!.click();
    await waitForText(page, 'Couldn’t copy. Your ticket link:');
    await waitForText(page, `/o/${officeId}/t/${id}`);
  });
});

describe('Referrer-Policy', () => {
  it('is no-referrer on pages, the API and static files', async () => {
    const { officeId, ticketId } = await officeWithTicket();
    const html = await (await fetch(`${app.base}/o/${officeId}/t/${ticketId}`)).text();
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset).toBeTruthy();
    for (const p of [`/o/${officeId}/t/${ticketId}`, `/api/o/${officeId}/tickets/${ticketId}`, '/api/meta', asset!, '/sw.js']) {
      expect((await fetch(`${app.base}${p}`)).headers.get('referrer-policy'), p).toBe('no-referrer');
    }
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });
});
