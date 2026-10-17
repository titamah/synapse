import crypto from 'crypto';
import express from 'express';
import { env } from '../config/environment.js';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { dataDeletionPage, privacyPage } from './pages.js';

/** Constant-time check of Meta's X-Hub-Signature-256 header against the raw body. */
function validMetaSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const received = Buffer.from(header);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export function createWebServer() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/privacy', (_req, res) => {
    res.type('html').send(privacyPage);
  });

  app.get('/data-deletion', (_req, res) => {
    res.type('html').send(dataDeletionPage);
  });

  // Meta calls this once when you save the webhook URL in the app dashboard.
  app.get('/webhooks/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (env.IG_VERIFY_TOKEN && mode === 'subscribe' && token === env.IG_VERIFY_TOKEN && typeof challenge === 'string') {
      res.type('text/plain').send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  // Every comment / story mention event. The raw body is kept for signature checking.
  app.post('/webhooks/instagram', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const rawBody = req.body as Buffer;
    const secrets = [env.IG_APP_SECRET, env.META_APP_SECRET].filter((s): s is string => !!s);
    if (!secrets.length) {
      console.warn('Instagram webhook rejected: no app secret configured');
      res.sendStatus(503);
      return;
    }
    const header = req.get('x-hub-signature-256');
    const signatureValid = secrets.some(secret => validMetaSignature(rawBody, header, secret));
    if (!signatureValid) {
      console.warn(`Instagram webhook rejected: bad signature (header ${header ? 'present' : 'missing'})`);
      res.sendStatus(401);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.sendStatus(400);
      return;
    }

    // Store first, process later: Meta only waits a few seconds for a 200.
    await db.insert(webhookEvents).values({ source: 'instagram', payload, signatureValid });
    console.log('Instagram webhook stored');
    res.sendStatus(200);
  });

  return app;
}

export function startWebServer() {
  const server = createWebServer().listen(env.PORT, () => {
    console.log(`Web server listening on :${env.PORT}`);
  });
  return server;
}
