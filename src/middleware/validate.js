import { ApiError } from '../utils/ApiError.js';

/** validate({ body, query, params }) with zod schemas; replaces req parts with parsed values. */
export const validate = (schemas) => (req, _res, next) => {
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const r = schemas[part].safeParse(req[part] ?? {});
    if (!r.success) {
      const details = {};
      for (const i of r.error.issues) details[i.path.join('.') || part] = i.message;
      return next(ApiError.badRequest('Validation failed', 'VALIDATION_ERROR', details));
    }
    if (part === 'query') { Object.keys(req.query).forEach((k) => delete req.query[k]); Object.assign(req.query, r.data); }
    else req[part] = r.data;
  }
  next();
};
