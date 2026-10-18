import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import { RATE_LIMIT } from './scripts';

export interface RateLimitRule {
  limit: number;
  windowSec: number;
}

/** Parse "20/60" (20 requests per 60 seconds). */
export function parseRule(value: string | undefined, fallback: RateLimitRule): RateLimitRule {
  const m = value?.match(/^(\d+)\/(\d+)$/);
  return m ? { limit: Number(m[1]), windowSec: Number(m[2]) } : fallback;
}

/**
 * Per-IP fixed-window rate limiter backed by Redis, so limits hold across
 * server restarts and multiple server processes.
 */
export function rateLimit(redis: Redis, root: string, name: string, rule: RateLimitRule) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${root}rl:${name}:${ip}`;
    try {
      const [count, pttl] = (await redis.eval(RATE_LIMIT, 1, key, String(rule.windowSec * 1000))) as [number, number];
      res.setHeader('RateLimit-Limit', String(rule.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, rule.limit - count)));
      if (count > rule.limit) {
        const retry = Math.max(1, Math.ceil(pttl / 1000));
        res.setHeader('Retry-After', String(retry));
        return res.status(429).json({
          error: 'rate_limited',
          message: `Too many requests. Please wait ${retry} second${retry === 1 ? '' : 's'} and try again.`,
        });
      }
    } catch (err) {
      // Never block real users because the limiter itself failed.
      console.error('rate limiter error', err);
    }
    next();
  };
}
