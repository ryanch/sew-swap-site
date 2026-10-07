import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config';
import { spanner, instance } from './spanner';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForEmulator(log: FastifyBaseLogger): Promise<void> {
  const deadline = Date.now() + 30_000;
  let delay = 500;
  for (;;) {
    try {
      await spanner.getInstances();
      log.info('Spanner emulator reachable');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      log.info(`Waiting for Spanner emulator (retry in ${delay}ms)`);
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

async function loadMigrations(): Promise<string[]> {
  const files = (await readdir(config.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const statements: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(config.migrationsDir, file), 'utf8');
    const withoutComments = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    statements.push(
      ...withoutComments
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return statements;
}

/**
 * Emulator-only: create the instance + database and apply migrations.
 * The emulator is in-memory, so this runs fresh on every container start.
 * In production, infra and migrations are managed outside the app.
 */
export async function bootstrapEmulator(log: FastifyBaseLogger): Promise<void> {
  if (!config.spanner.emulatorHost) return;

  await waitForEmulator(log);

  const [instanceExists] = await instance.exists();
  if (!instanceExists) {
    const [, op] = await spanner.createInstance(config.spanner.instance, {
      config: 'emulator-config',
      nodes: 1,
      displayName: 'Local emulator instance',
    });
    await op.promise();
    log.info(`Created Spanner instance ${config.spanner.instance}`);
  }

  const db = instance.database(config.spanner.database);
  const [dbExists] = await db.exists();
  if (!dbExists) {
    const schema = await loadMigrations();
    const [, op] = await instance.createDatabase(config.spanner.database, { schema });
    await op.promise();
    log.info(`Created database ${config.spanner.database} with ${schema.length} DDL statement(s)`);
  }
}
