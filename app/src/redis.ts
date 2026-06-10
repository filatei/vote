import { Redis } from 'ioredis';
import { config } from './config';
import { logger } from './logger';

export const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis error');
});
