import { pool } from '../db';

// Platform-wide runtime flags, cached in memory (single-instance app). Loaded
// once at startup from app_settings and updated in place whenever an admin
// changes one — so reads stay synchronous everywhere.
const cache = new Map<string, string>();

/** Load all settings into the in-memory cache (call after migrations, at boot). */
export async function loadSettings(): Promise<void> {
  const { rows } = await pool.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings`);
  cache.clear();
  for (const r of rows) cache.set(r.key, r.value);
}

/** Read a boolean flag; returns `def` when it has never been set. */
export function getBoolSetting(key: string, def: boolean): boolean {
  const v = cache.get(key);
  if (v === undefined) return def;
  return v === 'true';
}

/** Persist a boolean flag and update the cache immediately. */
export async function setBoolSetting(key: string, value: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value ? 'true' : 'false'],
  );
  cache.set(key, value ? 'true' : 'false');
}
