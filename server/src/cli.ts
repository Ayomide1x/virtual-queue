/**
 * Office admin from the terminal.
 *
 *   npm run office -- create [--name "Downtown DMV"] [--tz America/Chicago] [--seed]
 *   npm run office -- seed <officeId>
 *
 * In Docker: docker compose exec app node server/dist/cli.js create --seed
 */
import Redis from 'ioredis';
import { config } from './config';
import { getLanIp } from './network';
import { OfficeStore } from './offices';
import { seedOffice } from './seed';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const redis = new Redis(config.redisUrl);
  const offices = new OfficeStore(redis, { ttlSec: config.officeTtlSec });
  const lanIp = getLanIp(config.hostIp);
  const base = config.publicUrl ?? `http://${lanIp ?? 'localhost'}:${config.publicPort}`;
  try {
    if (command === 'create') {
      const tz = flag(args, 'tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { officeId, staffKey, config: cfg } = await offices.create({ name: flag(args, 'name'), timezone: tz });
      if (args.includes('--seed')) await seedOffice(redis, { prefix: offices.prefixFor(officeId), config: cfg, officeTtlSec: offices.ttlSec });
      console.log(`Created office “${cfg.name}” (${officeId})${args.includes('--seed') ? ' with sample residents' : ''}\n`);
      console.log(`  Staff (keep private): ${base}/o/${officeId}/staff#key=${staffKey}`);
      console.log(`  Lobby display:        ${base}/o/${officeId}/display`);
      console.log(`  Residents join:       ${base}/o/${officeId}/join`);
      console.log(`\n  Staff key: ${staffKey}`);
    } else if (command === 'seed' && args[0]) {
      const cfg = await offices.getConfig(args[0]);
      if (!cfg) throw new Error(`Office ${args[0]} not found (or expired).`);
      await seedOffice(redis, { prefix: offices.prefixFor(args[0]), config: cfg, officeTtlSec: offices.ttlSec });
      console.log(`Filled “${cfg.name}” with sample residents.`);
    } else {
      console.log('Usage:\n  office create [--name "Office name"] [--tz Area/City] [--seed]\n  office seed <officeId>');
      process.exitCode = 1;
    }
  } finally {
    await redis.quit();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
