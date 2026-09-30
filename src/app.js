import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import swaggerUi from 'swagger-ui-express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env, isProd } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiLimiter, webhookLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { msg91Receiver, brevoReceiver, brevo2Receiver, razorpayReceiver } from './webhooks/receivers.js';
import { buildRouter } from './routes/index.js';
import { buildOpenApi } from './config/openapi.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestLogger);
  // CSP allows only what the SPA needs: Razorpay Checkout (script + frame + XHR) and same-origin sockets.
  app.use(helmet({
    contentSecurityPolicy: isProd ? {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", 'https://checkout.razorpay.com'],
        'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        'connect-src': ["'self'", 'ws:', 'wss:', 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
        'img-src': ["'self'", 'data:', 'https:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'form-action': ["'self'", 'https://api.razorpay.com'],
      },
    } : false,
  }));
  app.use(cors({ origin: env.CLIENT_URL.split(',').map((s) => s.trim()), credentials: true }));
  app.use(compression());

  // Webhooks first: they need the RAW body for signature verification and must not be sanitised/reparsed.
  const raw = express.raw({ type: () => true, limit: '1mb' });
  app.post('/api/webhooks/msg91', webhookLimiter, raw, asyncHandler(msg91Receiver));
  app.post('/api/webhooks/brevo', webhookLimiter, raw, asyncHandler(brevoReceiver));
  app.post('/api/webhooks/brevo2', webhookLimiter, raw, asyncHandler(brevo2Receiver));
  app.post('/api/webhooks/razorpay', webhookLimiter, raw, asyncHandler(razorpayReceiver));

  // Email attachments are base64 so this one route accepts a larger body; everything else is capped at 1 MB.
  app.use('/api/email/send', express.json({ limit: '14mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(mongoSanitize({ replaceWith: '_' }));

  if (!isProd || env.NODE_ENV === 'development') {
    app.get('/api/docs.json', (_req, res) => res.json(buildOpenApi()));
  }
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(buildOpenApi(), { customSiteTitle: 'Unified Dashboard API' }));

  app.use('/api', apiLimiter, buildRouter());
  app.use('/api', notFoundHandler);

  // Optional: serve the built SPA from the same process (single-container deployments).
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
