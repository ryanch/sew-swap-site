import Fastify from 'fastify';
import { config } from './config';
import { authPlugin } from './auth/plugin';
import { bootstrapEmulator } from './db/bootstrap';
import { spanner } from './db/spanner';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { swapRoutes } from './routes/swaps';

async function main() {
  // trustProxy: Cloud Run (and the local Vite/nginx proxy) sit in front of the API.
  const app = Fastify({ logger: true, trustProxy: true });
  // JSON-only API: a cross-site <form> can only send form/text bodies, so this
  // (plus SameSite=Lax cookies) blocks CSRF on state-changing routes.
  app.removeContentTypeParser('text/plain');

  await bootstrapEmulator(app.log);
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(swapRoutes);

  // Cloud Run sends SIGTERM before stopping an instance.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      app.log.info(`${signal} received, shutting down`);
      await app.close();
      spanner.close();
      process.exit(0);
    });
  }

  await app.listen({ host: '0.0.0.0', port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
