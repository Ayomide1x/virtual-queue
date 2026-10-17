import Redis from 'ioredis';
import { createApp } from './app';
import { config } from './config';
import { getLanIp, runningInDocker } from './network';
import { QueueStore } from './queueStore';
import { seedDemo } from './seed';

async function main() {
  const redisOpts = { retryStrategy: (times: number) => Math.min(times * 250, 3000) };
  const redis = new Redis(config.redisUrl, redisOpts);
  const subscriber = new Redis(config.redisUrl, redisOpts);
  for (const [label, conn] of [['redis', redis], ['subscriber', subscriber]] as const) {
    conn.on('error', (err) => console.error(`[${label}] ${err.message}`));
  }

  const store = new QueueStore(redis, { counters: config.counters });

  if (config.seedOnStart !== 'never') {
    const state = await store.getStaffState();
    const empty = state.totals.waiting === 0 && state.totals.servedToday === 0;
    if (config.seedOnStart === 'always' || empty) {
      await seedDemo(redis, { counters: config.counters });
      console.log('Seeded demo data.');
    }
  }

  const lanIp = getLanIp(config.hostIp);
  const { server } = createApp({
    redis,
    subscriber,
    store,
    lanIp,
    publicJoinUrl: config.publicJoinUrl,
    webDist: config.webDist,
  });

  server.listen(config.port, config.host, () => {
    console.log(`Virtual queue server listening on http://${config.host}:${config.port}`);
    if (lanIp) console.log(`On your network:  http://${lanIp}:${config.publicPort}`);
    else if (runningInDocker()) {
      console.warn('HOST_IP is not set, so the lobby QR code cannot know your LAN address.');
      console.warn('Start with: HOST_IP=$(ipconfig getifaddr en0) docker compose up   (or ./scripts/up.sh)');
    }
  });

  const shutdown = () => {
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
