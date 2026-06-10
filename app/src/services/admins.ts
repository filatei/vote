import bcrypt from 'bcryptjs';
import { pool } from '../db';

export interface Admin {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  is_active: boolean;
}

export async function findAdminByUsername(username: string): Promise<Admin | null> {
  const { rows } = await pool.query<Admin>(
    `SELECT * FROM admins WHERE username = $1 AND is_active = TRUE`,
    [username],
  );
  return rows[0] ?? null;
}

export async function verifyPassword(admin: Admin, password: string): Promise<boolean> {
  return bcrypt.compare(password, admin.password_hash);
}

export async function recordLogin(adminId: number): Promise<void> {
  await pool.query(`UPDATE admins SET last_login_at = now() WHERE id = $1`, [adminId]);
}

/** Find or create the admin row for a Google-authenticated email. Password
 * login is impossible for these (placeholder hash never matches bcrypt). */
export async function upsertGoogleAdmin(email: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO admins (username, email, password_hash)
       VALUES ($1, $1, 'google-oauth')
     ON CONFLICT (username) DO UPDATE SET last_login_at = now(), email = EXCLUDED.email
     RETURNING id`,
    [email.toLowerCase()],
  );
  return rows[0].id;
}

export async function createAdmin(
  username: string,
  email: string | null,
  password: string,
): Promise<number> {
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO admins (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [username, email, hash],
  );
  return rows[0].id;
}

export async function logAction(params: {
  adminId: number | null;
  action: string;
  electionId?: number | null;
  detail?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (admin_id, action, election_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.adminId,
      params.action,
      params.electionId ?? null,
      JSON.stringify(params.detail ?? {}),
      params.ip ?? null,
    ],
  );
}

export async function getAuditLog(electionId: number): Promise<
  Array<{ action: string; detail: unknown; created_at: Date; username: string | null }>
> {
  const { rows } = await pool.query(
    `SELECT a.action, a.detail, a.created_at, ad.username
       FROM audit_log a
       LEFT JOIN admins ad ON ad.id = a.admin_id
      WHERE a.election_id = $1
      ORDER BY a.created_at DESC
      LIMIT 200`,
    [electionId],
  );
  return rows as any;
}
