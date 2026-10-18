import webpush from 'web-push';

/** What an alert says, independent of channel. */
export interface AlertMessage {
  title: string;
  body: string;
  /** Absolute (or site-relative) link to open. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
}

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/**
 * Thrown by senders. `retry` means a later attempt may succeed (timeouts, 429,
 * 5xx); `expired` means a push subscription is gone for good (404/410).
 */
export class AlertSendError extends Error {
  constructor(
    message: string,
    public readonly retry: boolean,
    public readonly expired = false,
  ) {
    super(message);
    this.name = 'AlertSendError';
  }
}

export interface PushSender {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  send(subscription: PushSubscriptionJSON, message: AlertMessage): Promise<void>;
}

export interface EmailSender {
  /** "resend" sends real email; "log" only logs (no API key configured). */
  readonly mode: 'resend' | 'log';
  send(to: string, message: AlertMessage): Promise<void>;
}

/** "ayomide@gmail.com" -> "a******@g****.com". Use for every log line. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const stars = (s: string) => (s.length <= 1 ? s : s[0] + '*'.repeat(Math.min(s.length - 1, 8)));
  return `${stars(local)}@${stars(host)}${tld}`;
}

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** Web Push (VAPID) via the `web-push` library. */
export class WebPushSender implements PushSender {
  readonly enabled = true;
  constructor(
    readonly publicKey: string,
    privateKey: string,
    subject: string,
  ) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }

  async send(subscription: PushSubscriptionJSON, message: AlertMessage): Promise<void> {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(message), { TTL: 60 * 30, urgency: 'high', topic: message.tag.slice(0, 32) });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) throw new AlertSendError(`push subscription expired (${status})`, false, true);
      if (status === undefined || isRetryableStatus(status)) throw new AlertSendError(`push failed (${status ?? (err as Error).message})`, true);
      throw new AlertSendError(`push rejected (${status})`, false);
    }
  }
}

/** Used when no VAPID keys are configured: push is simply unavailable. */
export class DisabledPushSender implements PushSender {
  readonly enabled = false;
  readonly publicKey = null;
  async send(): Promise<void> {
    throw new AlertSendError('push is not configured', false);
  }
}

/** Email through Resend's REST API (free tier). */
export class ResendEmailSender implements EmailSender {
  readonly mode = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, message: AlertMessage): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [to], subject: message.title, text: emailText(message), html: emailHtml(message) }),
      });
    } catch (err) {
      throw new AlertSendError(`email request failed (${(err as Error).message})`, true);
    }
    if (!res.ok) {
      throw new AlertSendError(`email rejected by Resend (${res.status})`, isRetryableStatus(res.status));
    }
  }
}

/** Used when RESEND_API_KEY is not set: logs what would have been sent, with the address masked. */
export class LogEmailSender implements EmailSender {
  readonly mode = 'log' as const;
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(to: string, message: AlertMessage): Promise<void> {
    this.log(`[email disabled: set RESEND_API_KEY] Would send “${message.title}” to ${maskEmail(to)}: ${message.body}`);
  }
}

export function emailText(m: AlertMessage): string {
  return `${m.body}\n\n${m.url}\n\nYou're getting this because you asked for alerts about your place in line. We delete your address when your visit ends.`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function emailHtml(m: AlertMessage): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f0f0f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1b1b">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;border:1px solid #dfe1e2">
<h1 style="margin:0 0 12px;font-size:22px;color:#112f4e">${esc(m.title)}</h1>
<p style="margin:0 0 20px;font-size:17px;line-height:1.5">${esc(m.body)}</p>
<a href="${esc(m.url)}" style="display:inline-block;background:#005ea2;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">Open</a>
<p style="margin:24px 0 0;font-size:13px;color:#565c65">You asked for alerts about your place in line. Your address is deleted when your visit ends.</p>
</div></body></html>`;
}
