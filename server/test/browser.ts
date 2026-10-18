/// <reference lib="dom" />
// Browser tests: the real built web app, served by the real server (against the
// test Redis), driven by headless Chrome, checked with axe-core.

import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AxePuppeteer } from '@axe-core/puppeteer';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { expect } from 'vitest';
import { AlertService } from '../src/alerts/service';
import { LogEmailSender, type PushSender } from '../src/alerts/senders';
import { createApp } from '../src/app';
import { OfficeStore } from '../src/offices';
import { connect, deleteUnder, uniqueRoot } from './helpers';

const WEB_DIR = path.resolve(__dirname, '../../web');

/** Build the web app once per test file, into a temp folder (never touches web/dist). */
export async function buildWeb(): Promise<string> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-web-'));
  const { build } = await import('vite');
  // vitest sets NODE_ENV=test, which would give a development React build.
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ root: WEB_DIR, configFile: path.join(WEB_DIR, 'vite.config.ts'), mode: 'production', logLevel: 'error', build: { outDir, emptyOutDir: true } });
  } finally {
    process.env.NODE_ENV = env;
  }
  return outDir;
}

/** Push "works" (so the Notify me button shows) but nothing is sent anywhere. */
const quietPush: PushSender = {
  enabled: true,
  publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  send: async () => {},
};

export interface TestApp {
  base: string;
  /** Call the API like a client would. */
  api: (method: string, path: string, body?: unknown, staffKey?: string) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startApp(webDist: string): Promise<TestApp> {
  const redis = connect();
  const root = uniqueRoot();
  const offices = new OfficeStore(redis, { root });
  const alerts = new AlertService({ redis, offices, push: quietPush, email: new LogEmailSender(() => {}), baseUrl: 'http://queue.example.test' });
  const { server, io } = createApp({
    redis,
    subscriber: connect(),
    offices,
    publicUrl: 'http://queue.example.test',
    lanIp: null,
    webDist,
    alerts,
    rateLimits: { createOffice: { limit: 10_000, windowSec: 60 }, join: { limit: 10_000, windowSec: 60 }, book: { limit: 10_000, windowSec: 60 }, notify: { limit: 10_000, windowSec: 60 } },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // 127.0.0.1 counts as a secure context, like https, so push UI renders.
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api: TestApp['api'] = async (method, p, body, staffKey) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (staffKey) headers['x-staff-key'] = staffKey;
    const r = await fetch(`${base}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return {
    base,
    api,
    close: async () => {
      alerts.stop();
      io.close();
      await deleteUnder(redis, root);
    },
  };
}

export async function launch(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
  });
}

/** A fresh page with its own storage (like a different phone). */
export async function newPage(browser: Browser, opts: { iphone?: boolean; width?: number } = {}): Promise<Page> {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: opts.width ?? 390, height: 844 });
  if (opts.iphone) {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push((e as Error).message));
  (page as Page & { errors: string[] }).errors = errors;
  return page;
}

export const pageErrors = (page: Page) => (page as Page & { errors?: string[] }).errors ?? [];

/** Wait until the page shows this text. */
export async function waitForText(page: Page, text: string, timeout = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

/** Click the first button/link/label whose text contains `text`. */
export async function clickText(page: Page, text: string, tag = '*') {
  const el = await page.waitForSelector(`xpath/.//${tag}[(self::button or self::a or self::label or self::summary) and contains(normalize-space(.), ${JSON.stringify(text)})]`, { timeout: 8000 });
  await el!.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await el!.click();
}

/**
 * Run axe on the page (WCAG 2.2 A/AA plus best practices) and fail with a
 * readable list of problems.
 */
export async function expectNoAxeViolations(page: Page, label: string) {
  // Let entry animations finish so colors are measured at their final values.
  await new Promise((r) => setTimeout(r, 350));
  const result = await new AxePuppeteer(page).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  const problems = result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes
      .slice(0, 5)
      .map((n) => `    ${n.target.join(' ')}  ${n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? ''}`)
      .join('\n')}`,
  );
  expect(problems, `axe found problems on ${label}:\n${problems.join('\n')}`).toEqual([]);
  expect(result.passes.length, `axe ran no checks on ${label}`).toBeGreaterThan(10);
}
