import mongoose from 'mongoose';
import '../../src/models/index.js';

/**
 * Build every declared index up-front so unique constraints (idempotency, dedupe) are enforced in tests.
 * FerretDB (used when no real mongod is available) lacks TTL indexes, so those options alone are dropped;
 * Partial-unique indexes degrade to plain indexes there too. On real MongoDB / mongodb-memory-server all are created as declared.
 */
export async function syncAllIndexes() {
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    await model.createCollection().catch(() => {});
    for (const [spec, options] of model.schema.indexes()) {
      const opts = { ...options };
      try {
        await model.collection.createIndex(spec, opts);
      } catch (err) {
        if (/expireAfterSeconds/.test(err.message)) { delete opts.expireAfterSeconds; await model.collection.createIndex(spec, opts); }
        else if (/partialFilterExpression/.test(err.message)) { delete opts.partialFilterExpression; delete opts.unique; await model.collection.createIndex(spec, opts); }
        else throw new Error(`index build failed for ${name} ${JSON.stringify(spec)}: ${err.message}`);
      }
    }
    // path-level indexes (unique: true / index: true on a field) are included in schema.indexes()
  }
}
