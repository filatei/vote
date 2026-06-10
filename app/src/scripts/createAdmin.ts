// Create (or note) an admin account.
//   node dist/scripts/createAdmin.js <username> [email] [password]
// If no password is given, a strong one is generated and printed once.
import { randomBytes } from 'crypto';
import { pool } from '../db';
import { createAdmin } from '../services/admins';

async function main() {
  const [username, email, passwordArg] = process.argv.slice(2);
  if (!username) {
    console.error('Usage: createAdmin <username> [email] [password]');
    process.exit(1);
  }
  const password = passwordArg || randomBytes(12).toString('base64url');
  try {
    const id = await createAdmin(username, email || null, password);
    console.log('✓ Admin created.');
    console.log(`  id:       ${id}`);
    console.log(`  username: ${username}`);
    if (!passwordArg) {
      console.log(`  password: ${password}`);
      console.log('  ^ Save this now — it will not be shown again.');
    }
  } catch (err: any) {
    if (err?.code === '23505') {
      console.error(`Admin "${username}" already exists.`);
    } else {
      console.error('Failed to create admin:', err?.message || err);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
