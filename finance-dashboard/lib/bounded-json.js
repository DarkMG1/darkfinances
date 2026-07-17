const { KnownPreApplyError } = require('./errors');

class MalformedJsonError extends KnownPreApplyError {
  constructor(message = 'Request body is not valid JSON') {
    super(message, { code: 'INVALID_REQUEST', status: 400 });
    this.name = 'MalformedJsonError';
  }
}

class PayloadTooLargeError extends KnownPreApplyError {
  constructor(message = 'Request body is too large') {
    super(message, { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    this.name = 'PayloadTooLargeError';
  }
}

class UnsupportedMediaTypeError extends KnownPreApplyError {
  constructor(message = 'Content-Type must be application/json') {
    super(message, { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    this.name = 'UnsupportedMediaTypeError';
  }
}

function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    const declaredNumber = declared === undefined ? NaN : Number(declared);
    if (Number.isFinite(declaredNumber) && declaredNumber > maxBytes) {
      reject(new PayloadTooLargeError());
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (raw) => {
      if (settled) return;
      settled = true;
      resolve(raw);
    };

    req.on('data', (chunk) => {
      if (declared === '0' && chunk.length > 0) {
        fail(new MalformedJsonError('Request body must be empty when Content-Length is 0'));
        return;
      }
      total += chunk.length;
      if (Number.isFinite(declaredNumber) && declaredNumber >= 0 && total > declaredNumber) {
        fail(new MalformedJsonError('Request body exceeds Content-Length'));
        return;
      }
      if (total > maxBytes) {
        req.destroy();
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new PayloadTooLargeError()));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (declared === '0' && raw.length > 0) {
        fail(new MalformedJsonError('Request body must be empty when Content-Length is 0'));
        return;
      }
      if (Number.isFinite(declaredNumber) && declaredNumber >= 0 && raw.length !== declaredNumber) {
        fail(new MalformedJsonError('Request body length does not match Content-Length'));
        return;
      }
      finish(raw);
    });
  });
}

function parseBoundedJson(raw, { allowEmpty = true } = {}) {
  const text = raw.length ? raw.toString('utf8') : '';
  if (!text) {
    if (allowEmpty) return {};
    throw new MalformedJsonError('Request body is required');
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new MalformedJsonError('Request body must be a JSON object');
    }
    return value;
  } catch (error) {
    if (error instanceof MalformedJsonError) throw error;
    throw new MalformedJsonError();
  }
}

function jsonContentTypeOk(contentType) {
  const value = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return value === 'application/json';
}

function headerValue(req, name) {
  if (typeof req.get === 'function') return req.get(name) || '';
  const key = String(name).toLowerCase();
  return req.headers[key] || '';
}

function boundedJsonMiddleware({ limit, requireJson = true, allowEmpty = true }) {
  return async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      return next(new UnsupportedMediaTypeError('Content-Encoding is not supported'));
    }

    const contentType = headerValue(req, 'Content-Type');
    try {
      const raw = await readBoundedBody(req, limit);
      if (requireJson && raw.length > 0 && !jsonContentTypeOk(contentType)) {
        throw new UnsupportedMediaTypeError();
      }
      req.rawBody = raw;
      req.body = parseBoundedJson(raw, { allowEmpty });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  MalformedJsonError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  boundedJsonMiddleware,
  jsonContentTypeOk,
  parseBoundedJson,
  readBoundedBody,
};
