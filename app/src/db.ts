import { Pool, PoolClient } from 'pg';
import { config } from './config';
import { logger } from './logger';

export const pool = new Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle Postgres client error');
});

/**
 * Run `fn` inside a SERIALIZABLE transaction. Retries a bounded number of times
 * on serialization failures (SQLSTATE 40001), which is how Postgres signals a
 * detected conflict under SERIALIZABLE isolation. This is what makes the
 * "redeem a code exactly once" guarantee safe under concurrency.
 */
export async function withSerializableTx<T>(
  fn: (client: PoolClient) => Promise<T>,
  maxRetries = 5,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code === '40001' && attempt < maxRetries) {
        attempt += 1;
        // brief backoff before retry
        await new Promise((r) => setTimeout(r, 25 * attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
