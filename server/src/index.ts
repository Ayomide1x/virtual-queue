import Redis from 'ioredis';
import { AlertService } from './alerts/service';
import { DisabledPushSender, LogEmailSender, ResendEmailSender, WebPushSender } from './alerts/senders';
import { createApp } from './app';
import { config } from './config';
import { createErrorTracker } from './errors';
import { createLogger, isLogLevel } from './logger';
import { getLanIp, runningInDocker } from './network';
import { OfficeStore } from './offices';

async function main() {
  const production = config.environment === 'production';
  const log = createLogger({
    level: isLogLevel(config.logLevel) ? config.logLevel : 'info',
    format: config.logFormat === 'pretty' || config.logFormat === 'json' ? config.logFormat : production ? 'json' : 'pretty',
    base: { service: 'virtual-queue' },
  });
  const errors = await createErrorTracker({ dsn: config.sentryDsn, environment: config.environment, release: config.version ?? undefined, logger: log });

  // Last-resort handlers: record the problem, then (for a thrown exception) exit,
  // since the process may be in a broken state. Docker restarts it.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { err: reason });
    errors.capture(reason, { source: 'process' });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    errors.capture(err, { source: 'process' });
    void errors.flush(2000).finally(() => process.exit(1));
  });

  const redisOpts = { retryStrategy: (times: number) => Math.min(times * 250, 3000) };
  const redis = new Redis(config.redisUrl, redisOpts);
  const subscriber = new Redis(config.redisUrl, redisOpts);
  for (const [label, conn] of [['redis', redis], ['subscriber', subscriber]] as const) {
    const redisLog = log.child({ component: label });
    conn.on('error', (err) => redisLog.warn('redis connection error', { err: err.message }));
    conn.on('ready', () => redisLog.info('redis ready'));
  }

  const offices = new OfficeStore(redis, { ttlSec: config.officeTtlSec, analyticsDays: config.analyticsDays });
  const lanIp = getLanIp(config.hostIp);
  const a = config.alerts;
  const alertLog = log.child({ component: 'alerts' });
  const baseUrl = config.publicUrl ?? (lanIp ? `http://${lanIp}:${config.publicPort}` : `http://localhost:${config.publicPort}`);
  const alerts = new AlertService({
    redis,
    offices,
    push: a.vapidPublicKey && a.vapidPrivateKey ? new WebPushSender(a.vapidPublicKey, a.vapidPrivateKey, a.vapidSubject) : new DisabledPushSender(),
    email: a.resendApiKey ? new ResendEmailSender(a.resendApiKey, a.emailFrom) : new LogEmailSender((line) => alertLog.info(line)),
    baseUrl,
    log: (line) => (/worker error|scan failed|gave up/.test(line) ? alertLog.warn(line) : alertLog.info(line)),
  });
  alerts.start();
  const handle = createApp({
    alerts,
    redis,
    subscriber,
    offices,
    publicUrl: config.publicUrl,
    lanIp,
    webDist: config.webDist,
    rateLimits: config.rateLimits,
    trustProxy: config.trustProxy,
    logger: log,
    errors,
    version: config.version ?? undefined,
  });

  handle.server.listen(config.port, config.host, () => {
    log.info('listening', { host: config.host, port: config.port, publicUrl: baseUrl, version: config.version, environment: config.environment });
    log.info(`Open ${baseUrl} and click "Create an office" (or run: npm run office -- create --seed)`);
    log.info('alerts', {
      push: alerts.push.enabled ? 'on' : 'off (run npm run setup:alerts)',
      email: alerts.email.mode === 'resend' ? 'via Resend' : 'logged only (set RESEND_API_KEY)',
      errorTracking: errors.enabled ? 'on' : 'off (set SENTRY_DSN)',
    });
    if (!config.publicUrl && !lanIp && runningInDocker()) {
      log.warn('PUBLIC_URL is not set, so lobby QR codes cannot point at your LAN address.');
    }
  });

  // Graceful shutdown (docker stop, Ctrl+C, deploys): stop taking new work,
  // let in-flight requests and alert sends finish, then close Redis.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    log.info('shutting down', { signal });
    const force = setTimeout(() => {
      log.error('shutdown took too long; exiting anyway', { timeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();
    try {
      await handle.close();
      await alerts.shutdown(Math.max(1000, config.shutdownTimeoutMs - 2000));
      await Promise.allSettled([redis.quit(), subscriber.quit()]);
      await errors.flush(1000);
      log.info('shutdown complete', { ms: Date.now() - t0 });
      process.exit(0);
    } catch (err) {
      log.error('shutdown failed', { err });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Before the logger exists (bad config); keep it simple.
  console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'failed to start', err: { message: (err as Error).message, stack: (err as Error).stack } }));
  process.exit(1);
});
