import { env, isProd } from '../config/env.js';
import { connectDb, disconnectDb } from '../config/db.js';
import { Customer } from '../models/index.js';

/**
 * Development-only sample data. It is refused unless ENABLE_MOCK_DATA=true and NODE_ENV is not production.
 * It creates clearly labelled sample CUSTOMERS only. It never fabricates messages, emails, payments or provider
 * responses, so dashboard statistics always reflect real provider activity.
 */
const SAMPLES = [
  { firstName: 'Asha', lastName: 'Verma', phone: '919800000001', email: 'asha.sample@example.com', company: 'Sample Traders' },
  { firstName: 'Rohit', lastName: 'Nair', phone: '919800000002', email: 'rohit.sample@example.com', company: 'Sample Foods' },
  { firstName: 'Meera', lastName: 'Iyer', phone: '919800000003', email: 'meera.sample@example.com', company: 'Sample Studio' },
];

export async function seedMockCustomers() {
  if (!env.ENABLE_MOCK_DATA) throw new Error('ENABLE_MOCK_DATA is not true. Nothing was created.');
  if (isProd) throw new Error('Mock data is never created in production.');
  let created = 0;
  for (const s of SAMPLES) {
    if (await Customer.exists({ phone: s.phone })) continue;
    await Customer.create({ ...s, source: 'Manual', status: 'lead', tags: ['sample-data'] });
    created += 1;
  }
  return created;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await connectDb();
    console.log(`Created ${await seedMockCustomers()} sample customers (tagged "sample-data").`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}
