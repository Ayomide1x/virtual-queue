import type { Logger } from './logger';
import { redactPath } from './logger';

// Error tracking, off unless SENTRY_DSN is set. When on, unexpected server
// errors (5xx, crashed background jobs, uncaught exceptions) and errors reported
// by browsers are sent to Sentry, or any Sentry-compatible service such as
// GlitchTip. Nothing personal is sent: no request bodies, headers, cookies or
// IP addresses, and secret ticket/appointment ids are stripped from URLs.

export interface ErrorContext {
  /** Where it happened, e.g. "http", "alerts", "web". */
  source?: string;
  requestId?: string;
  officeId?: string;
  path?: string;
  extra?: Record<string, unknown>;
}

export interface ErrorTracker {
  readonly enabled: boolean;
  capture(err: unknown, ctx?: ErrorContext): void;
  /** Send anything queued (call before exiting). */
  flush(timeoutMs?: number): Promise<void>;
}

export const disabledErrorTracker: ErrorTracker = {
  enabled: false,
  capture: () => {},
  flush: async () => {},
};

type SentryModule = typeof import('@sentry/node');

/** Remove anything that could identify a resident or unlock a ticket. */
export function scrubEvent<E extends object>(event: E): E {
  const e = event as { request?: { url?: unknown; method?: string }; user?: unknown; breadcrumbs?: unknown; extra?: Record<string, unknown> };
  if (e.request) {
    const url = typeof e.request.url === 'string' ? redactPath(e.request.url) : undefined;
    e.request = url ? { url, method: e.request.method } : { method: e.request.method };
  }
  delete e.user;
  delete e.breadcrumbs;
  if (e.extra && typeof e.extra.path === 'string') e.extra.path = redactPath(e.extra.path);
  return event;
}

export async function createErrorTracker(opts: { dsn?: string; environment?: string; release?: string; logger: Logger }): Promise<ErrorTracker> {
  if (!opts.dsn) return disabledErrorTracker;
  let Sentry: SentryModule;
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: opts.dsn,
      environment: opts.environment,
      release: opts.release,
      // Errors only: no tracing, no automatic instrumentation, no personal data.
      defaultIntegrations: false,
      integrations: [],
      beforeSend: (event) => scrubEvent(event),
    });
  } catch (err) {
    opts.logger.error('error tracking could not start; continuing without it', { err });
    return disabledErrorTracker;
  }
  opts.logger.info('error tracking on', { environment: opts.environment });
  return {
    enabled: true,
    capture(err, ctx = {}) {
      Sentry.withScope((scope) => {
        if (ctx.source) scope.setTag('source', ctx.source);
        if (ctx.officeId) scope.setTag('office', ctx.officeId);
        if (ctx.requestId) scope.setTag('request_id', ctx.requestId);
        if (ctx.path) scope.setExtra('path', redactPath(ctx.path));
        for (const [k, v] of Object.entries(ctx.extra ?? {})) scope.setExtra(k, v);
        if (err instanceof Error) Sentry.captureException(err);
        else Sentry.captureMessage(String(err), 'error');
      });
    },
    async flush(timeoutMs = 2000) {
      await Sentry.flush(timeoutMs).catch(() => false);
    },
  };
}
