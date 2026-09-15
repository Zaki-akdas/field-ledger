// One-off: set SLM-00's password to field123 using the app's own hashPassword,
// so tools/overflow-check.mjs can sign in as a salesman locally.
import pg from 'pg';
import { hashPassword } from '../server/auth.js';

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL });
await c.connect();
await c.query('UPDATE users SET password_hash = $1 WHERE code = $2', [hashPassword('field123'), 'SLM-00']);
const { rows } = await c.query("SELECT code, left(password_hash, 18) AS ph FROM users WHERE code = 'SLM-00'");
console.log('done:', rows);
await c.end();
