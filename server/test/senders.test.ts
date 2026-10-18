import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertSendError, LogEmailSender, ResendEmailSender, WebPushSender, emailHtml, type AlertMessage } from '../src/alerts/senders';

const message: AlertMessage = { title: 'It’s your turn: D-042', body: 'Please go to <Window A> now.', url: 'https://q.example/o/abc/join', tag: 'vq-1' };

describe('ResendEmailSender', () => {
  const fakeFetch = (status: number, calls: Array<{ url: string; init: RequestInit }>) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;

  it('posts the message to Resend with the API key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await new ResendEmailSender('re_test_key', 'Queue <q@example.org>', fakeFetch(200, calls)).send('ana@example.org', message);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ from: 'Queue <q@example.org>', to: ['ana@example.org'], subject: message.title });
    expect(body.text).toContain(message.url);
    expect(body.html).toContain('&lt;Window A&gt;'); // escaped
  });

  it('marks 429/5xx and network errors retryable, other 4xx permanent', async () => {
    const send = (status: number) => new ResendEmailSender('k', 'f@example.org', fakeFetch(status, [])).send('a@example.org', message);
    await expect(send(429)).rejects.toMatchObject({ retry: true });
    await expect(send(503)).rejects.toMatchObject({ retry: true });
    await expect(send(422)).rejects.toMatchObject({ retry: false });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new ResendEmailSender('k', 'f@example.org', offline).send('a@example.org', message)).rejects.toMatchObject({ retry: true });
  });

  it('escapes HTML in emails', () => {
    expect(emailHtml({ ...message, title: '<script>x</script>' })).not.toContain('<script>');
  });
});

describe('LogEmailSender', () => {
  it('logs instead of sending, with the address masked', async () => {
    const lines: string[] = [];
    await new LogEmailSender((l) => lines.push(l)).send('someone.private@example.org', message);
    expect(lines[0]).toContain('s********@e******.org');
    expect(lines[0]).not.toContain('someone.private');
  });
});

// A local HTTPS server standing in for a browser push service (FCM, Mozilla, Apple…).
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('WebPushSender against a push service', () => {
  let server: https.Server;
  let endpoint: string;
  let respond = 201;
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
  const keys = webpush.generateVAPIDKeys();
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = () => ({ endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-push-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`], { stdio: 'ignore' });
    server = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(respond).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/push/abc`;
    // Trust the self-signed test certificate (this test file runs in its own worker).
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  });
  afterAll(() => server?.close());

  it('sends an encrypted, VAPID-signed request', async () => {
    respond = 201;
    await new WebPushSender(keys.publicKey, keys.privateKey, 'mailto:ops@example.org').send(subscription(), message);
    const req = received.at(-1)!;
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(String(req.headers.authorization)).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    expect(req.headers.urgency).toBe('high');
    expect(Number(req.headers.ttl)).toBeGreaterThan(0);
    // The payload is encrypted for the subscriber: the text must not be readable in transit.
    expect(req.body.length).toBeGreaterThan(100);
    expect(req.body.toString('latin1')).not.toContain('Window A');
  });

  it('maps push service responses: 410 expired, 503 retry, 400 permanent', async () => {
    const sender = new WebPushSender(keys.publicKey, keys.privateKey, 'mailto:ops@example.org');
    respond = 410;
    await expect(sender.send(subscription(), message)).rejects.toMatchObject({ expired: true, retry: false });
    respond = 404;
    await expect(sender.send(subscription(), message)).rejects.toMatchObject({ expired: true });
    respond = 503;
    await expect(sender.send(subscription(), message)).rejects.toMatchObject({ expired: false, retry: true });
    respond = 400;
    const err = await sender.send(subscription(), message).catch((e) => e);
    expect(err).toBeInstanceOf(AlertSendError);
    expect(err).toMatchObject({ retry: false, expired: false });
  });
});
