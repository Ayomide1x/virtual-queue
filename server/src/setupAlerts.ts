/**
 * Generates VAPID keys for web push and stores them in the repo's .env, which
 * both `npm run dev` and `docker compose` read.
 *
 *   npm run setup:alerts            # create keys if missing
 *   npm run setup:alerts -- --force # replace them (existing subscriptions stop working)
 */
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const envPath = path.resolve(__dirname, '../../.env');
const force = process.argv.includes('--force');
const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
const has = (name: string) => lines.some((l) => l.startsWith(`${name}=`) && l.length > name.length + 1);
const set = (name: string, value: string) => {
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
};

if (has('VAPID_PUBLIC_KEY') && has('VAPID_PRIVATE_KEY') && !force) {
  console.log(`VAPID keys already exist in ${envPath}. Use --force to replace them.`);
} else {
  const keys = webpush.generateVAPIDKeys();
  set('VAPID_PUBLIC_KEY', keys.publicKey);
  set('VAPID_PRIVATE_KEY', keys.privateKey);
  if (!has('VAPID_SUBJECT')) set('VAPID_SUBJECT', 'mailto:admin@example.com');
  console.log(`Wrote new VAPID keys to ${envPath}.`);
}
if (!lines.some((l) => l.startsWith('RESEND_API_KEY='))) {
  lines.push('', '# Email alerts (optional): a Resend API key and a sender on a domain you verified in Resend.', 'RESEND_API_KEY=', 'EMAIL_FROM=Virtual Queue <onboarding@resend.dev>');
}
fs.writeFileSync(envPath, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim() + '\n', { mode: 0o600 });
console.log('\nNext:');
console.log('  • Set VAPID_SUBJECT to a mailto: address you read (push services contact it about problems).');
console.log('  • Optional: set RESEND_API_KEY (free at resend.com) for email alerts; without it emails are only logged.');
console.log('  • Restart the server (or: docker compose up -d --build).');
console.log('  • Web push only works over HTTPS (or localhost). See docs/alerts.md.');
