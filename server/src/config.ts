import fs from 'node:fs';
import path from 'node:path';
import { parseRule } from './rateLimit';

// Local runs read the repo's .env (written by `npm run setup:alerts`). Variables
// already set in the environment win. In Docker, compose passes them in.
const envFile = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`Could not read ${envFile}: ${(err as Error).message}`);
  }
}

const publicPort = Number(process.env.PUBLIC_PORT ?? process.env.PORT ?? 3000);
const hostIp = process.env.HOST_IP || undefined;

function parseTrustProxy(v: string | undefined): boolean | number | string | undefined {
  if (!v) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const pkgVersion = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
})();

export const config = {
  /** Shown by /health and attached to error reports. Set APP_VERSION (e.g. a git SHA) in CI or deploys. */
  version: process.env.APP_VERSION || pkgVersion,
  environment: process.env.APP_ENV || process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL,
  /** "json" (default in production) or "pretty". */
  logFormat: process.env.LOG_FORMAT,
  /** Error tracking: Sentry (or GlitchTip, etc.) is used only when this is set. */
  sentryDsn: process.env.SENTRY_DSN || undefined,
  /** How long a graceful shutdown may take before the process exits anyway. */
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000),
  port: Number(process.env.PORT ?? 3000),
  /** Port as seen from outside (differs from `port` when Docker maps it). */
  publicPort,
  host: process.env.HOST ?? '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  /** Host machine's LAN IP. Required when running in Docker, which can't see it. */
  hostIp,
  /**
   * Base URL that phones use to reach the app; the lobby QR code and share
   * links are built from it. Defaults to http://HOST_IP:PORT when HOST_IP is set.
   */
  publicUrl: (process.env.PUBLIC_URL || (hostIp ? `http://${hostIp}:${publicPort}` : '')).replace(/\/+$/, '') || null,
  officeTtlSec: Number(process.env.OFFICE_TTL_DAYS ?? 30) * 24 * 60 * 60,
  /** Days of ticket history (analytics) an active office keeps. */
  analyticsDays: Math.max(7, Number(process.env.ANALYTICS_RETENTION_DAYS ?? 90)),
  rateLimits: {
    createOffice: parseRule(process.env.RATE_LIMIT_CREATE_OFFICE, { limit: 10, windowSec: 3600 }),
    join: parseRule(process.env.RATE_LIMIT_JOIN, { limit: 30, windowSec: 60 }),
    book: parseRule(process.env.RATE_LIMIT_BOOK, { limit: 10, windowSec: 600 }),
    notify: parseRule(process.env.RATE_LIMIT_NOTIFY, { limit: 20, windowSec: 600 }),
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  alerts: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || null,
    /** Contact for push services, "mailto:you@example.com" or an https URL. */
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    resendApiKey: process.env.RESEND_API_KEY || null,
    /** Sender address; must be on a domain verified in Resend (or onboarding@resend.dev for testing). */
    emailFrom: process.env.EMAIL_FROM || 'Virtual Queue <onboarding@resend.dev>',
  },
  webDist: process.env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist'),
};
