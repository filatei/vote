import path from 'path';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { config } from './config';
import { formatWat, toWatInput } from './util/datetime';
import { logger } from './logger';
import { redis } from './redis';
import { healthCheck } from './db';
import { runMigrations } from './migrate';
import { generalLimiter } from './middleware/rateLimit';
import { errorHandler, notFound } from './middleware/errors';
import { publicRouter } from './routes/public';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { accountAuthRouter, accountRouter } from './routes/account';

const app = express();

if (config.TRUST_PROXY) {
  // Trust the single Apache reverse proxy in front of us.
  app.set('trust proxy', 1);
}

// Views (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers. CSP locks scripts/styles to same-origin (no inline JS used).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

app.use(pinoHttp({ logger }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

// Sessions (admin only) stored in Redis.
app.use(
  session({
    name: 'vote.sid',
    store: new RedisStore({ client: redis, prefix: 'sess:' }),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  }),
);

// Static assets
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProd ? '7d' : 0,
    fallthrough: true,
  }),
);

// Uploaded contestant photos (persisted volume in production).
app.use(
  '/uploads',
  express.static(config.UPLOAD_DIR, {
    maxAge: config.isProd ? '7d' : 0,
    index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }),
);

// Expose base url + year + WAT formatters to all templates
app.use((_req, res, next) => {
  res.locals.baseUrl = config.PUBLIC_BASE_URL;
  res.locals.year = new Date().getFullYear();
  res.locals.formatWat = formatWat;
  res.locals.toWatInput = toWatInput;
  next();
});

app.use(generalLimiter);

// Health endpoint for the container/orchestrator.
app.get('/healthz', async (_req, res) => {
  const dbOk = await healthCheck();
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded' });
});

// Routes
app.use('/admin', authRouter); // /admin/login, /admin/logout
app.use('/admin', adminRouter); // protected admin area
app.use('/account', accountAuthRouter); // /account/login, /verify, /logout
app.use('/account', accountRouter); // protected customer area
app.use('/', publicRouter);

// 404 + error handling
app.use(notFound);
app.use(errorHandler);

// Apply idempotent migrations, then start listening.
runMigrations().catch((err) => {
  logger.error({ err }, 'Migration failed at startup');
  process.exit(1);
});

const server = app.listen(config.APP_PORT, () => {
  logger.info(`Torama Vote listening on :${config.APP_PORT} (${config.NODE_ENV})`);
});

// Graceful shutdown
function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
