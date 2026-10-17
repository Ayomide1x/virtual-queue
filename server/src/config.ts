import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Port as seen from outside (differs from `port` when Docker maps it). */
  publicPort: Number(process.env.PUBLIC_PORT ?? process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  counters: Number(process.env.COUNTERS ?? 6),
  /** Host machine's LAN IP. Required when running in Docker, which can't see it. */
  hostIp: process.env.HOST_IP || undefined,
  /** Full override for the join URL encoded in the lobby QR code. */
  publicJoinUrl: process.env.PUBLIC_JOIN_URL || undefined,
  /** "always" | "if-empty" | "never" */
  seedOnStart: (process.env.SEED_ON_START ?? 'never') as 'always' | 'if-empty' | 'never',
  webDist: process.env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist'),
};
