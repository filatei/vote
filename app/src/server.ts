import path from 'path';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { config } from './config';
import { formatWat, toWatInput } from './util/datetime';
import { avatarSvg, avatarColor } from './util/avatar';
import { parseVideoUrl } from './util/video';

// Changes each process start → used to cache-bust /static assets after a deploy.
const ASSET_VER = String(Date.now());
import { logger } from './logger';
import { redis } from './redis';
import { healthCheck } from './db';
import { runMigrations } from './migrate';
import { loadSettings } from './services/settings';
import { generalLimiter } from './middleware/rateLimit';
import { errorHandler, notFound } from './middleware/errors';
import { publicRouter } from './routes/public';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { accountAuthRouter, accountRouter } from './routes/account';
import { webhookRouter } from './routes/webhooks';
import { paymentsEnabled, priceLabel } from './services/payments';

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
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://i9.ytimg.com'],
        mediaSrc: ["'self'", 'https:'],
        frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        // Allow the subscribe form to redirect on to the Lemon Squeezy hosted
        // checkout (browsers enforce form-action against the redirect target).
        formAction: ["'self'", 'https://*.lemonsqueezy.com'],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

app.use(pinoHttp({ logger }));

// Paystack webhook needs the RAW body for signature verification, so mount it
// before the urlencoded body parser.
app.use('/webhooks', webhookRouter);

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
app.use((req, res, next) => {
  res.locals.baseUrl = config.PUBLIC_BASE_URL;
  // Canonical absolute URL of the current page (no query) for og:url / canonical.
  res.locals.currentUrl = config.PUBLIC_BASE_URL + req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.formatWat = formatWat;
  res.locals.toWatInput = toWatInput;
  res.locals.priceLabel = priceLabel();
  res.locals.paymentsEnabled = paymentsEnabled();
  // Landing explainer video (YouTube embed or direct file). Defaults to the
  // configured Torama Vote YouTube clip.
  res.locals.video = parseVideoUrl(config.LANDING_VIDEO_URL || 'https://youtu.be/Cafnwp8FElk');
  res.locals.assetVer = ASSET_VER;
  res.locals.avatarSvg = avatarSvg;
  res.locals.avatarColor = avatarColor;
  next();
});

app.use(generalLimiter);

// Serve the favicon at the conventional root path browsers auto-request.
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// PWA: service worker (served at root so its scope covers the whole app) +
// web app manifest with the correct content type.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

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

// Apply idempotent migrations, load runtime settings, then start listening.
runMigrations()
  .then(loadSettings)
  .catch((err) => {
    logger.error({ err }, 'Startup (migrations/settings) failed');
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
