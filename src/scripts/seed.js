import { env } from '../config/env.js';
import { connectDb, disconnectDb } from '../config/db.js';
import { User } from '../models/index.js';
import { hashPassword } from '../services/auth.service.js';
import { passwordPolicy } from '../validators/auth.validators.js';

const ACCOUNTS = [
  { role: 'SUPER_ADMIN', prefix: 'SUPER_ADMIN', fallbackName: 'Super Admin' },
  { role: 'ADMIN', prefix: 'ADMIN', fallbackName: 'Admin' },
  { role: 'OPERATOR', prefix: 'OPERATOR', fallbackName: 'Operator' },
];

/** Creates the three dashboard accounts from environment variables. Existing accounts are never overwritten. */
export async function seedUsers() {
  const results = [];
  for (const a of ACCOUNTS) {
    const email = env[`${a.prefix}_EMAIL`];
    const password = env[`${a.prefix}_PASSWORD`];
    if (!email || !password) throw new Error(`${a.prefix}_EMAIL and ${a.prefix}_PASSWORD must be set`);
    const pw = passwordPolicy.safeParse(password);
    if (!pw.success) throw new Error(`${a.prefix}_PASSWORD: ${pw.error.issues[0].message}`);
    if (await User.exists({ role: a.role })) { results.push({ role: a.role, created: false }); continue; }
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || a.role.toLowerCase();
    await User.create({
      name: env[`${a.prefix}_NAME`] || a.fallbackName, email, username: username.length >= 3 ? username : `${username}_user`,
      role: a.role, passwordHash: await hashPassword(password), passwordChangedAt: new Date(),
    });
    results.push({ role: a.role, email, created: true });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await connectDb();
    const out = await seedUsers();
    for (const r of out) console.log(`${r.created ? 'created' : 'exists '}  ${r.role}${r.email ? `  ${r.email}` : ''}`);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}
