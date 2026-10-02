import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { sha256 } from './security/crypto.js';
import { HttpError } from './security/rbac.js';
import { routes } from './routes/plugin.js';

export async function buildServer() {
  const app = Fastify({ logger: { level: config.NODE_ENV === 'test' ? 'silent' : 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] }, trustProxy: true, bodyLimit: 1_000_000 });
  await app.register(helmet);
  await app.register(cookie, { secret: sha256(`cookie:${config.MASTER_KEY}`) });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // CORS for the web app only, with credentials.
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin === config.WEB_ORIGIN) {
      reply.header('access-control-allow-origin', config.WEB_ORIGIN).header('access-control-allow-credentials', 'true').header('vary', 'origin')
        .header('access-control-allow-headers', 'content-type,x-requested-with').header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues });
    if ((err as { statusCode?: number }).statusCode === 429) return reply.code(429).send({ error: 'Rate limit exceeded' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });          // never leak internals or stack traces
  });

  await app.register(routes);
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await buildServer();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}
