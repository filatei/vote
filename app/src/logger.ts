import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  // Never log request bodies / cookies — they could contain voting codes.
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'req.body'],
    remove: true,
  },
});
