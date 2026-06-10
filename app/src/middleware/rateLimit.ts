import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../redis';

function store(prefix: string) {
  return new RedisStore({
    // Bridge express-rate-limit's variadic sendCommand to ioredis .call().
    sendCommand: (...args: string[]): Promise<any> =>
      (redis.call as (...a: string[]) => Promise<any>)(...args),
    prefix,
  });
}

/** Throttle voting-code attempts to defeat brute-forcing of codes. */
export const codeAttemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 20, // 20 code attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:code:'),
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

/** Throttle admin login attempts. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:login:'),
  message: 'Too many login attempts. Please wait and try again.',
});

/** General protection for the rest of the site. */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:gen:'),
});
