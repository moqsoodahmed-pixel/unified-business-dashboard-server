export class ApiError extends Error {
  constructor(status, message, errorCode = 'ERROR', details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
    this.expose = true;
  }
  static badRequest(msg = 'Bad request', code = 'BAD_REQUEST', details) { return new ApiError(400, msg, code, details); }
  static unauthorized(msg = 'Authentication required', code = 'UNAUTHORIZED') { return new ApiError(401, msg, code); }
  static forbidden(msg = 'You do not have permission to do that', code = 'FORBIDDEN') { return new ApiError(403, msg, code); }
  static notFound(msg = 'Not found', code = 'NOT_FOUND') { return new ApiError(404, msg, code); }
  static conflict(msg = 'Conflict', code = 'CONFLICT', details) { return new ApiError(409, msg, code, details); }
  static unprocessable(msg = 'Unprocessable', code = 'UNPROCESSABLE', details) { return new ApiError(422, msg, code, details); }
  static notConfigured(provider) { return new ApiError(409, `${provider} is not configured.`, 'NOT_CONFIGURED'); }
  static upstream(msg, code = 'UPSTREAM_ERROR') { return new ApiError(502, msg, code); }
}
