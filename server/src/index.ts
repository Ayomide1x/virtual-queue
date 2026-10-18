import Redis from 'ioredis';
import { AlertService } from './alerts/service';
import { DisabledPushSender, LogEmailSender, ResendEmailSender, WebPushSender } from './alerts/senders';
import { createApp } from './app';
import { config } from './config';
import { getLanIp, runningInDocker } from './network';
import { OfficeStore } from './offices';

async function main() {
  const redisOpts = { retryStrategy: (times: number) => Math.min(times * 250, 3000) };
  const redis = new Redis(config.redisUrl, redisOpts);
  const subscriber = new Redis(config.redisUrl, redisOpts);
  for (const [label, conn] of [['redis', redis], ['subscriber', subscriber]] as const) {
    conn.on('error', (err) => console.error(`[${label}] ${err.message}`));
  }

  const offices = new OfficeStore(redis, { ttlSec: config.officeTtlSec });
  const lanIp = getLanIp(config.hostIp);
  const a = config.alerts;
  const alerts = new AlertService({
    redis,
    offices,
    push: a.vapidPublicKey && a.vapidPrivateKey ? new WebPushSender(a.vapidPublicKey, a.vapidPrivateKey, a.vapidSubject) : new DisabledPushSender(),
    email: a.resendApiKey ? new ResendEmailSender(a.resendApiKey, a.emailFrom) : new LogEmailSender(),
    baseUrl: config.publicUrl ?? (lanIp ? `http://${lanIp}:${config.publicPort}` : `http://localhost:${config.publicPort}`),
  });
  alerts.start();
  const { server } = createApp({
    alerts,
    redis,
    subscriber,
    offices,
    publicUrl: config.publicUrl,
    lanIp,
    webDist: config.webDist,
    rateLimits: config.rateLimits,
    trustProxy: config.trustProxy,
  });

  server.listen(config.port, config.host, () => {
    const base = config.publicUrl ?? (lanIp ? `http://${lanIp}:${config.publicPort}` : `http://localhost:${config.publicPort}`);
    console.log(`Virtual queue server listening on http://${config.host}:${config.port}`);
    console.log(`Open ${base} and click "Create an office" (or run: npm run office -- create --seed)`);
    console.log(
      `Alerts: push ${alerts.push.enabled ? 'on' : 'off (run npm run setup:alerts)'}, email ${alerts.email.mode === 'resend' ? 'via Resend' : 'logged only (set RESEND_API_KEY)'}`,
    );
    if (!config.publicUrl && !lanIp && runningInDocker()) {
      console.warn('PUBLIC_URL is not set, so lobby QR codes cannot point at your LAN address.');
      console.warn('Start with ./scripts/up.sh, or: PUBLIC_URL=http://$(ipconfig getifaddr en0):3000 docker compose up');
    }
  });

  const shutdown = () => {
    alerts.stop();
    server.close();
    void Promise.allSettled([redis.quit(), subscriber.quit()]).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
