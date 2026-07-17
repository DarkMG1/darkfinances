const { AppError, classifyError } = require('./errors');
const { sanitizeIssues } = require('./request-issues');

const API_ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: { status: 401, message: 'UNAUTHENTICATED' },
  CORS_ORIGIN_REJECTED: { status: 403, message: 'Origin not allowed' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed' },
  NOT_FOUND: { status: 404, message: 'Not found' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
});

function apiErrorBody(error, req) {
  const classified = classifyError(error);
  const body = {
    error: classified.expose ? classified.message : 'Request failed',
    code: classified.code,
    requestId: req.requestId,
  };
  if (error && Array.isArray(error.issues) && error.issues.length) {
    body.issues = sanitizeIssues(error.issues);
  }
  return { status: classified.status, body };
}

function sendApiError(req, res, error) {
  const classified = classifyError(error);
  if (classified.status >= 500) {
    console.error(`[request:${req.requestId}]`, (error && error.stack) || error);
  }
  const payload = apiErrorBody(error, req);
  if (classified.status === 429) {
    const retryAfter = error?.retryAfterSeconds;
    if (retryAfter != null) res.setHeader('Retry-After', String(retryAfter));
  }
  return res.status(payload.status).json(payload.body);
}

function sendApiErrorCode(req, res, code, overrides = {}) {
  const definition = API_ERROR_CODES[code];
  if (!definition) throw new Error(`Unknown API error code: ${code}`);
  return sendApiError(req, res, new AppError(overrides.message || definition.message, {
    code,
    status: overrides.status || definition.status,
    expose: true,
  }));
}

function apiErrorMiddleware() {
  return (error, req, res, next) => {
    if (!error) return next();
    if (res.headersSent) return next(error);
    return sendApiError(req, res, error);
  };
}

module.exports = {
  API_ERROR_CODES,
  apiErrorBody,
  apiErrorMiddleware,
  sendApiError,
  sendApiErrorCode,
};
