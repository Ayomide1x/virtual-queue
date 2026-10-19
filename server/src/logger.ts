// Structured logging: one JSON object per line in production (easy to ship to
// any log tool), short readable lines in development. No dependencies.
//
// Never log secrets. Ticket and appointment ids are bearer secrets and appear
// in URLs, so paths go through redactPath(); email addresses are masked by
// their callers (see maskEmail); staff keys travel in a header we never log.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line (e.g. { component: 'alerts' }). */
  child(fields: LogFields): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  /** Where lines go (default: stdout for debug/info, stderr for warn/error). */
  write?: (line: string, level: LogLevel) => void;
  base?: LogFields;
  now?: () => Date;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** "/api/o/abc/tickets/0f8f…/notify?x=1" → "/api/o/abc/tickets/:id/notify" (no query, no secret ids). */
export function redactPath(url: string): string {
  return url.split(/[?#]/)[0].replace(UUID, ':id');
}

/** Errors become plain objects (JSON.stringify drops their fields otherwise). */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const out: LogFields = { name: value.name, message: value.message };
    if (value.stack) out.stack = value.stack.split('\n').slice(0, 12).join('\n');
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    return out;
  }
  return value;
}

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && v in ORDER;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const format = opts.format ?? 'json';
  const now = opts.now ?? (() => new Date());
  const write =
    opts.write ??
    ((line: string, lvl: LogLevel) => {
      (ORDER[lvl] >= ORDER.warn ? process.stderr : process.stdout).write(line + '\n');
    });

  const make = (base: LogFields): Logger => {
    const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
      if (ORDER[lvl] < ORDER[level]) return;
      const all: LogFields = { ...base, ...fields };
      for (const k of Object.keys(all)) all[k] = serialize(all[k]);
      if (format === 'json') {
        write(JSON.stringify({ time: now().toISOString(), level: lvl, msg, ...all }), lvl);
      } else {
        const extras = Object.entries(all)
          .filter(([k]) => k !== 'err')
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ');
        const err = all.err as { stack?: string; message?: string } | undefined;
        const time = now().toISOString().slice(11, 19);
        write(`${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${extras ? `  ${extras}` : ''}${err ? `\n${err.stack ?? err.message}` : ''}`, lvl);
      }
    };
    return {
      level,
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(opts.base ?? {});
}

/** Silent logger for tests and tools. */
export const nullLogger: Logger = createLogger({ write: () => {} });
