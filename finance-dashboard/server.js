const express = require('express');
const NodeCache = require('node-cache');
const path = require('path');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const crypto = require('crypto');
const {
  AccountNotFoundError,
  AppError,
  KnownPreApplyError,
  TransactionNotFoundError,
  classifyError,
} = require('./lib/errors');
const { FINANCE_TIME_ZONE, todayYMD } = require('./lib/date-only');
const { SerialQueue } = require('./lib/serial-queue');
const { bindGracefulShutdownSignals } = require('./lib/graceful-shutdown');
const { createBrowserStaticMiddleware, isPublicBrowserAsset } = require('./lib/browser-static');
const { getActualCoordinator } = require('./lib/actual-coordinator');
const { loadAdmissionLimitsConfig } = require('./lib/admission-limits-config');
const {
  resetRequestAdmissionController,
} = require('./lib/request-admission');
const {
  createClientAbortSignal,
  withMutationAdmission,
  withOperationStatusAdmission,
  withReadAdmission,
} = require('./lib/request-admission-runtime');
const { OperationJournal } = require('./lib/operation-journal');
const { executeJournaledOperation } = require('./lib/operation-executor');
const { reconcileOperationJournalFromProof } = require('./lib/operation-reconciliation');
const {
  MUTATION_ROUTES,
  getMutationRoute,
  routeKey,
} = require('./lib/mutation-route-registry');
const { parse, schemas } = require('./lib/validation');
const { createReconnectFreshnessProbeService } = require('./lib/reconnect-freshness-probe');
const { deriveRequestPrincipal } = require('./lib/request-principal');
const { readReleaseIdentity } = require('./lib/release-identity');
const {
  exportExitCode,
  buildReimbursementExportV1Envelope,
  formatReimbursementExportCsv,
  formatReimbursementExportHuman,
  stableStringify,
} = require('./lib/reimbursement-export-ledger');
const { boundedJsonMiddleware } = require('./lib/bounded-json');
const {
  attachQueryStatsHeaders,
  assertCursorSigningConfigured,
  buildQueryCacheFingerprint,
  runWithQueryInstrumentation,
} = require('./lib/bounded-ledger-access');
const { loadQueryScalingConfig } = require('./lib/query-scaling-config');
const {
  DEFAULT_MAX_JSON_BYTES,
  RECEIPT_MAX_JSON_BYTES,
} = require('./lib/receipt-limits');
const {
  apiErrorMiddleware,
  sendApiError,
  sendApiErrorCode,
} = require('./lib/request-envelope');
const {
  findMutationContract,
  parsePhantomCleanupRequest,
  parseReceiptRequest,
  parseRecurringOverrideRequest,
  validateLegacyMutationRequest,
  validateVersionedMutationRequest,
  versionedRouteExists,
} = require('./lib/request-contract');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache
const actualCoordinator = getActualCoordinator();
actualCoordinator.bindCache(cache);
const admissionLimitsConfig = loadAdmissionLimitsConfig();
const requestAdmission = resetRequestAdmissionController(admissionLimitsConfig);
const mutationQueue = new SerialQueue('finance-mutations', {
  maxPending: admissionLimitsConfig.mutationGlobalPending,
});
const operationJournal = new OperationJournal();
const RELEASE_MANIFEST_PATH = process.env.RELEASE_MANIFEST_PATH || path.join(__dirname, 'release-manifest.json');

function queryFingerprintBase() {
  const c = loadQueryScalingConfig();
  return {
    maxLedgerDays: c.maxLedgerQueryDays,
    maxLedgerRows: c.maxLedgerRowsPerRead,
    maxTxnList: c.maxTransactionListRows,
    maxSearchLimit: c.maxSearchLimit,
    maxSearchRange: c.maxSearchRangeDays,
    maxMerchantMonths: c.maxMerchantHistoryMonths,
    ledgerChunkDays: c.ledgerChunkDays,
  };
}
const runtimeHealth = {
  startedAt: new Date().toISOString(),
  fatalErrorAt: null,
};

function releaseIdentity() {
  return readReleaseIdentity(RELEASE_MANIFEST_PATH, __dirname);
}

const reconnectFreshnessProbe = createReconnectFreshnessProbeService({
  coordinator: actualCoordinator,
  readAccountsProbe: () => data.getAccounts(),
  financeTimeZone: FINANCE_TIME_ZONE,
  deployIdentity: releaseIdentity,
});

// Defense-in-depth: the Actual API occasionally rejects a batch write out-of-band
// (a promise that escapes the awaited call). Continuing after an unknown write
// failure can expose partial state, so mark the process unhealthy and let systemd
// replace it instead of serving potentially inconsistent data.
process.on('unhandledRejection', (err) => {
  runtimeHealth.fatalErrorAt = new Date().toISOString();
  console.error('[unhandledRejection]', (err && err.stack) || err);
  if (process.env.NODE_ENV !== 'test') {
    const timer = setTimeout(() => process.exit(1), 100);
    timer.unref();
  }
});

const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 5007}`;
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'DarkFinances';
const RP_ID = process.env.WEBAUTHN_RP_ID || (() => {
  try { return new URL(PUBLIC_ORIGIN).hostname; }
  catch (_) { return 'localhost'; }
})();
const ORIGIN = process.env.WEBAUTHN_ORIGIN || PUBLIC_ORIGIN;
const PASSKEY_USER_NAME = process.env.PASSKEY_USER_NAME || 'owner';
const PASSKEY_USER_DISPLAY_NAME = process.env.PASSKEY_USER_DISPLAY_NAME || PASSKEY_USER_NAME;
const CREDS_FILE = process.env.PASSKEY_CREDENTIALS_FILE || path.join(__dirname, 'passkey-credentials.json');
const {
  loadPasskeyCredentials,
  savePasskeyCredentials,
} = require('./lib/passkey-credentials-store');
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '.sessions');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ENROLLMENT_TOKEN_HASH = String(process.env.PASSKEY_ENROLLMENT_TOKEN_HASH || '').toLowerCase();
const ENROLLMENT_EXPIRES_AT = Number(process.env.PASSKEY_ENROLLMENT_EXPIRES_AT || 0);
const SELFTEST = process.env.SELFTEST === '1';
const publicHostname = (() => {
  try { return new URL(PUBLIC_ORIGIN).hostname; } catch (_) { return ''; }
})();
const localOrigin = publicHostname === 'localhost' || publicHostname === '127.0.0.1' || publicHostname === '::1';

if (!process.env.SESSION_SECRET && !localOrigin) {
  throw new Error('SESSION_SECRET is required for a non-local deployment');
}
if (!localOrigin && process.env.DEMO_ONLY !== '1') {
  assertCursorSigningConfigured();
}
if (SELFTEST && !localOrigin) {
  throw new Error('SELFTEST may only be used with a loopback PUBLIC_ORIGIN');
}

function loadCreds() {
  return loadPasskeyCredentials(CREDS_FILE);
}
function saveCreds(creds) {
  savePasskeyCredentials(creds, CREDS_FILE);
}
function requestClaimsDemo(req) {
  return req.get('X-Demo-Mode') === '1' || req.query.demo === '1' || req.query.demo === 'true';
}
function safeEqualHex(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function enrollmentAvailable() {
  return /^[a-f0-9]{64}$/.test(ENROLLMENT_TOKEN_HASH) && ENROLLMENT_EXPIRES_AT > Date.now();
}
function enrollmentAuthorized(req, creds) {
  if (req.session?.authenticated) return true;
  return creds.length === 0 &&
    req.session?.enrollmentAuthorized === true &&
    Number(req.session.enrollmentExpiresAt || 0) > Date.now();
}

const rateBuckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (rateBuckets.size > 5000) {
      for (const [k, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(k);
    }
    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      if (req.path.startsWith('/api/')) {
        const error = new AppError('Too many requests', {
          code: 'RATE_LIMITED',
          status: 429,
          expose: true,
        });
        error.retryAfterSeconds = retryAfterSeconds;
        return sendApiError(req, res, error);
      }
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.disable('etag');
fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(SESSION_DIR, 0o700);
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; " +
      "script-src 'self'; " +
      "style-src 'self'; " +
      "font-src 'self'; img-src 'self' data:; connect-src 'self'"
  );
  next();
});

const isVersionedApiPath = (value) => /^\/api\/v1(?:\/|$)/i.test(value || '');
const isVersionedApiRequest = (req) => isVersionedApiPath(req.baseUrl) || isVersionedApiPath(req.originalUrl);
const isReceiptUpload = (req) =>
  req.method === 'POST' && /^\/api(?:\/v1)?\/receipts\/?$/i.test(req.path);
const defaultJsonMiddleware = boundedJsonMiddleware({ limit: DEFAULT_MAX_JSON_BYTES });
const receiptJsonMiddleware = boundedJsonMiddleware({ limit: RECEIPT_MAX_JSON_BYTES });
app.use((req, res, next) => (isReceiptUpload(req) ? receiptJsonMiddleware : defaultJsonMiddleware)(req, res, next));
app.use(session({
  store: new FileStore({
    path: SESSION_DIR,
    ttl: 7 * 24 * 60 * 60,
    retries: 0,
    reapInterval: 60 * 60,
    logFn: (message) => console.error('[session-store]', message),
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: !localOrigin, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' },
}));

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== ORIGIN) {
    if (req.path.startsWith('/api/')) return sendApiErrorCode(req, res, 'CORS_ORIGIN_REJECTED');
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use((req, res, next) => requestClaimsDemo(req)
  ? rateLimit('demo', 240, 60_000)(req, res, next)
  : next());

function requireAuth(req, res, next) {
  if (SELFTEST) return next();
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// Auth routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/status', (req, res) => {
  const creds = loadCreds();
  res.json({
    registered: creds.length > 0,
    authenticated: !!req.session.authenticated,
    enrollmentAvailable: creds.length === 0 && enrollmentAvailable(),
  });
});

const loginLimiter = rateLimit('passkey-login', 30, 10 * 60_000);
const enrollmentLimiter = rateLimit('passkey-enrollment', 10, 10 * 60_000);

// First enrollment requires a short-lived out-of-band code. Once one credential
// exists, further enrollment requires an already-authenticated browser session.
app.post('/auth/enroll/authorize', enrollmentLimiter, (req, res) => {
  try {
    const creds = loadCreds();
    if (creds.length > 0) return res.status(409).json({ error: 'A passkey is already registered' });
    if (!enrollmentAvailable()) return res.status(403).json({ error: 'Enrollment is closed' });
    const suppliedHash = crypto.createHash('sha256').update(String(req.body?.code || '')).digest('hex');
    if (!safeEqualHex(suppliedHash, ENROLLMENT_TOKEN_HASH)) {
      return res.status(403).json({ error: 'Invalid enrollment code' });
    }
    req.session.enrollmentAuthorized = true;
    req.session.enrollmentExpiresAt = ENROLLMENT_EXPIRES_AT;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Could not authorize enrollment' });
  }
});

app.post('/auth/register/start', enrollmentLimiter, async (req, res) => {
  try {
    const creds = loadCreds();
    if (!enrollmentAuthorized(req, creds)) return res.status(403).json({ error: 'Registration closed' });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: crypto.randomBytes(16),
      userName: PASSKEY_USER_NAME,
      userDisplayName: PASSKEY_USER_DISPLAY_NAME,
      attestationType: 'none',
      excludeCredentials: creds.map(c => ({ id: c.credentialID, type: 'public-key', transports: c.transports || [] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    req.session.regChallenge = options.challenge;
    return res.json(options);
  } catch (e) {
    return res.status(500).json({ error: 'Could not start registration' });
  }
});

app.post('/auth/register/finish', enrollmentLimiter, async (req, res) => {
  try {
    const creds = loadCreds();
    if (!enrollmentAuthorized(req, creds)) return res.status(403).json({ error: 'Registration closed' });
    if (!req.session.regChallenge) return res.status(400).json({ error: 'Registration challenge expired' });
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: req.session.regChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
    const { credential } = verification.registrationInfo;
    if (creds.some((c) => c.credentialID === credential.id)) {
      return res.status(409).json({ error: 'Credential already registered' });
    }
    creds.push({
      credentialID: credential.id,
      credentialPublicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: req.body.response?.transports || [],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    saveCreds(creds);
    req.session.authenticated = true;
    delete req.session.regChallenge;
    delete req.session.enrollmentAuthorized;
    delete req.session.enrollmentExpiresAt;
    return res.json({ ok: true });
  } catch (e) {
    delete req.session.regChallenge;
    return res.status(400).json({ error: 'Registration verification failed' });
  }
});

// Authentication
app.post('/auth/login/start', loginLimiter, async (req, res) => {
  try {
    const creds = loadCreds();
    if (!creds.length) return res.status(409).json({ error: 'No passkey is registered' });
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: creds.map(c => ({ id: c.credentialID, transports: c.transports || [] })),
    });
    req.session.authChallenge = options.challenge;
    return res.json(options);
  } catch (e) {
    return res.status(500).json({ error: 'Could not start authentication' });
  }
});

app.post('/auth/login/finish', loginLimiter, async (req, res) => {
  try {
    if (!req.session.authChallenge) return res.status(400).json({ error: 'Authentication challenge expired' });
    const creds = loadCreds();
    const credId = req.body.id;
    const cred = creds.find(c => c.credentialID === credId);
    if (!cred) return res.status(400).json({ error: 'Credential not found' });
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: req.session.authChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.credentialID,
        publicKey: Buffer.from(cred.credentialPublicKey, 'base64'),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
    cred.counter = verification.authenticationInfo.newCounter;
    cred.lastUsedAt = new Date().toISOString();
    saveCreds(creds);
    req.session.authenticated = true;
    delete req.session.authChallenge;
    return res.json({ ok: true });
  } catch (e) {
    delete req.session.authChallenge;
    return res.status(400).json({ error: 'Authentication verification failed' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// All Actual Budget reads/computations live in the shared data module so the web
// dashboard, the JSON API, and the native app all use one source of truth.
const data = require('./dataModule');

// Fully synthetic dataset used by "Demo Mode" (showcasing without exposing real
// finances). It never touches Actual; the middleware below short-circuits any
// request flagged demo (header X-Demo-Mode:1 or ?demo=1) before the resolvers run.
const demo = require('./demoData');
function isDemo(req) { return requestClaimsDemo(req); }
function validateLegacyMutationBoundary(req, res, next) {
  if (!['POST', 'DELETE', 'PATCH'].includes(req.method)) return next();
  // Versioned real writes validate inside their admitted operation so a known
  // pre-effect rejection is durable and replayable. Demo and legacy requests
  // retain this outer boundary because they are not operation-journaled.
  if (isVersionedApiRequest(req) && !isDemo(req)) return next();
  const contract = findMutationContract(req);
  if (!contract) return next();
  try {
    validateLegacyMutationRequest(req);
    return next();
  } catch (error) {
    return sendApiError(req, res, error);
  }
}
function demoMiddleware(v1mode) {
  return (req, res, next) => {
    if (!isDemo(req)) return next();
    if (!v1mode && isVersionedApiPath(req.path)) return next(); // let the v1 router envelope it
    const send = (payload) => res.json(v1mode ? { data: payload } : payload);
    const p = req.path.replace(/^\/api\/v1\//i, '').replace(/^\/api\//i, '').replace(/^\//, '');
    if (req.method === 'POST' || req.method === 'DELETE') {
      // Public demo writes are intentionally non-persistent. This keeps showcase
      // flows harmless and prevents cross-user state, OCR, or HTML injection.
      const knownWrite = [
        /^transactions$/i,
        /^transactions\/[^/]+(?:\/(?:category|notes|date|payee|split|unsplit))?$/i,
        /^bank-sync$/i,
        /^reimbursements\/sweep$/i,
        /^phantom\/cleanup$/i,
        /^receipts(?:\/[^/]+)?$/i,
        /^rules(?:\/apply|\/[^/]+)?$/i,
        /^splitwise\/sync-shares$/i,
        /^events(?:\/[^/]+)?$/i,
        /^accounts\/[^/]+\/override$/i,
        /^manual-assets(?:\/[^/]+)?$/i,
        /^recurring\/(?:mark|[^/]+\/override)$/i,
        /^bills\/paid$/i,
        /^owes-config$/i,
        /^reimb-links$/i,
        /^repayments\/[^/]+\/(?:confirm|dismiss)$/i,
        /^reconciliation\/(?:item|month|enabled)$/i,
        /^review\/dispositions$/i,
        /^goals(?:\/[^/]+)?$/i,
        /^refresh$/i,
      ].some((pattern) => pattern.test(p));
      if (!knownWrite) return sendApiErrorCode(req, res, 'NOT_FOUND');
      return send({ ok: true, demo: true });
    }
    if (p === 'report.csv') {
      const lines = ['Monthly report (DEMO),sample', '', 'Date,Payee,Account,Category,Amount,Notes'];
      for (const t of demo.transactions()) lines.push([t.date, csvEscape(t.payee), csvEscape(t.account), csvEscape(t.category || ''), t.amount, csvEscape(t.notes || '')].join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="finance-demo.csv"');
      return res.send(lines.join('\n'));
    }
    const txnById = p.match(/^transactions\/([^/]+)$/);
    if (txnById) return send(demo.transactionDetail(decodeURIComponent(txnById[1])));
    if (p === 'merchant-history') return send(demo.merchantHistory({ payee: req.query.payee, months: req.query.months }));
    if (p === 'reconciliation') return send(demo.reconciliation(req.query.month ? String(req.query.month) : undefined));
    if (p === 'reconciliation/pending') return send(demo.reconcilePending());
    if (p === 'repayments/suggestions') return send(demo.repaymentSuggestions());
    if (p === 'reimbursement-ledger') return send(demo.reimbursementLedger ? demo.reimbursementLedger(req.query.month) : { month: new Date().toISOString().slice(0, 7), range: {}, totals: {}, people: [], months: [] });
    if (p === 'reimbursement-export') {
      const format = String(req.query.format || 'json').toLowerCase();
      const payload = demo.reimbursementExport();
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.send(formatReimbursementExportCsv(payload));
      }
      if (format === 'human') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(formatReimbursementExportHuman(payload));
      }
      if (v1mode) {
        return res.type('application/json').send(`${buildReimbursementExportV1Envelope(payload)}\n`);
      }
      res.setHeader('X-Reimbursement-Export-Status', payload.completeness.status);
      res.setHeader('X-Reimbursement-Export-Exit-Code', String(exportExitCode(payload)));
      res.setHeader('X-Reimbursement-Export-Authoritative', String(payload.totals.authoritative));
      return res.type('application/json').send(stableStringify(payload));
    }
    if (p === 'events') return send(demo.events());
    if (p === 'receipts') return send(demo.receipts(req.query.txnId ? String(req.query.txnId) : undefined));
    switch (p) {
      case 'ping': return send({ ok: true, ts: Date.now() });
      case 'reconnect-freshness':
        return sendApiError(req, res, new AppError('Reconnect freshness probe is not supported in demo mode', {
          code: 'RECONNECT_FRESHNESS_DEMO_UNSUPPORTED',
          status: 404,
          expose: true,
        }));
      case 'accounts': return send(demo.accounts());
      case 'today': return send(demo.today());
      case 'transactions': {
        let r = demo.transactions();
        const { category, bucket, start, end } = req.query;
        const budgetOnly = req.query.budgetOnly === '1' || req.query.budgetOnly === 'true';
        const groupByCategory = Object.fromEntries(demo.categories().map((c) => [String(c.name || '').toLowerCase(), String(c.group || '').toLowerCase()]));
        const bucketFor = (t) => {
          const cat = String(t.category || '').toLowerCase();
          const group = groupByCategory[cat] || '';
          const key = `${cat} ${group}`;
          if (!cat || cat === 'reimbursement' || group === 'income' || group === 'money movement') return null;
          if (t.amount > 0) return null;
          if (/rent|housing|electric|internet|phone|utilities?|water|sewer|trash|insurance|loan|mortgage/.test(key)) return 'bills';
          if (/subscription|streaming|software|cloud/.test(key)) return 'subscriptions';
          return 'spending';
        };
        if (bucket) {
          const wantBucket = String(bucket).toLowerCase();
          r = r.filter((t) => bucketFor(t) === wantBucket);
        }
        if (budgetOnly) {
          const accountByName = Object.fromEntries(demo.accounts().map((a) => [String(a.name || '').toLowerCase(), a]));
          r = r.filter((t) => !accountByName[String(t.account || '').toLowerCase()]?.offbudget);
        }
        if (category) {
          const want = String(category).toLowerCase();
          r = r.filter((t) => {
            const cat = String(t.category || '').toLowerCase();
            return cat === want || groupByCategory[cat] === want;
          });
        }
        if (start) r = r.filter((t) => t.date >= start);
        if (end) r = r.filter((t) => t.date <= end);
        return send(r);
      }
      case 'spending': return send(demo.spending({ month: req.query.month, start: req.query.start, end: req.query.end }));
      case 'trends': return send(demo.trends(parseInt(req.query.months, 10) || 12));
      case 'budgets': return send(demo.budgets());
      case 'reimbursement': return send(demo.reimbursement());
      case 'review': return send(demo.review());
      case 'insights': return send(demo.insights());
      case 'categories': return send(demo.categories());
      case 'recurring': return send(demo.recurring());
      case 'bills': return send(demo.bills());
      case 'forecast': return send(demo.forecast(parseInt(req.query.days, 10) || 90));
      case 'income': return send(demo.income());
      case 'search': {
        const needle = (req.query.q || '').toLowerCase().trim();
        const all = demo.transactions();
        const r = needle ? all.filter((t) =>
          (t.payee || '').toLowerCase().includes(needle) ||
          (t.category || '').toLowerCase().includes(needle) ||
          (t.account || '').toLowerCase().includes(needle) ||
          (t.notes || '').toLowerCase().includes(needle)) : all;
        return send({ transactions: r.slice(0, 200), total: r.length, truncated: r.length > 200 });
      }
      case 'tags': return send(demo.tags());
      case 'rules': return send(demo.rules());
      case 'manual-assets': return send(demo.manualAssets());
      case 'investments': return send(demo.investments());
      case 'reports': return send(demo.reports());
      case 'goals': return send(demo.goals());
      case 'owes-config': return send({ expected: {}, debtorPatterns: {}, tripStart: {}, swNet: [], settledExt: [] });
      case 'reimb-links': return send(demo.reimbLinks(req.query.id ? String(req.query.id) : undefined));
      default: {
        return sendApiErrorCode(req, res, 'NOT_FOUND');
      }
    }
  };
}

function invalidateHttpCache() {
  actualCoordinator.invalidateGeneration();
}

// Generation-bound keys are filled via cachedActual and must never be evicted with
// plain cache.del — always use invalidateActualProjection so generation advances.
// Local keys (rules, manual-assets, investments) use cachedLocal / invalidateLocalCache.
function invalidateActualProjection(...keys) {
  const list = keys.flat().filter(Boolean);
  actualCoordinator.invalidateGeneration(list.length > 0 ? { keys: list } : {});
}

// Sidecar writes that change Actual-derived HTTP projections must hold the
// coordinator write lane through persistence and invalidation so overlapping
// cachedActual fills cannot publish under a post-mutation generation while the
// sidecar is still pre-mutation.
function runActualProjectionMutation(task, ...keys) {
  const list = keys.flat().filter(Boolean);
  const label = list.length > 0 ? list.join(',') : 'all';
  return actualCoordinator.runWrite(async () => {
    try {
      return await task();
    } finally {
      // Sidecar persistence may succeed before journal local_applied throws
      // (OUTCOME_UNKNOWN). Invalidate so cachedActual cannot serve pre-mutation
      // projections after durable sidecar writes. Pre-effect task errors are
      // safe to invalidate — no durable mutation occurred.
      if (list.length > 0) invalidateActualProjection(...list);
      else invalidateActualProjection();
    }
  }, { invalidateBefore: false, label: `projection:${label}` });
}

function invalidateLocalCache(...keys) {
  const list = keys.flat().filter(Boolean);
  if (list.length === 0) cache.flushAll();
  else cache.del(list);
}

function cachedLocal(key, fn, ttl = 300) {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return fn().then((value) => {
    cache.set(key, value, ttl);
    return value;
  });
}

function cachedActual(key, fn, ttl = 300) {
  return actualCoordinator.cachedRead(key, fn, ttl);
}

function publicReviewInbox(inbox) {
  if (!inbox || typeof inbox !== 'object') return inbox;
  const { _allTasks, _maintenance, ...rest } = inbox;
  return rest;
}

async function loadReviewInbox(req) {
  const month = monthOf(req);
  const inbox = await cachedActual(
    `review-${month || 'current'}`,
    () => data.getReview({ month }),
    120,
  );
  const maintenance = inbox._maintenance;
  if (maintenance?.expiredSnoozeKeys?.length) {
    await actualCoordinator.runWrite(
      () => data.persistReviewStateMaintenance({
        expectedRevision: maintenance.expectedRevision,
        expiredSnoozeKeys: maintenance.expiredSnoozeKeys,
      }),
      { label: 'review:maintenance' },
    );
  }
  return publicReviewInbox(inbox);
}

// Hot cache keys the app + dashboard hit on load. Keys MUST match the strings the
// resolvers compute for their default params so a warmed entry is actually reused.
// Keeping these warm means a sync/refresh (or process start) never forces the next
// request to recompute the heavy 18-month aggregations from scratch.
const WARM_TARGETS = [
  { key: 'accounts', ttl: 300, fn: () => data.getAccounts() },
  { key: buildQueryCacheFingerprint({ kind: 'spending', month: 'current', start: '', end: '', ...queryFingerprintBase() }), ttl: 180, fn: () => data.getSpending({ month: undefined }) },
  { key: buildQueryCacheFingerprint({ kind: 'trends', months: 12, endMonth: 'current', ...queryFingerprintBase() }), ttl: 600, fn: () => data.getTrends({ months: 12 }) },
  { key: buildQueryCacheFingerprint({ kind: 'trends', months: 60, endMonth: 'current', ...queryFingerprintBase() }), ttl: 600, fn: () => data.getTrends({ months: 60 }) },
  { key: buildQueryCacheFingerprint({ kind: 'recurring', window: 18, ...queryFingerprintBase() }), ttl: 600, fn: () => data.getRecurring({ window: 18 }) },
  { key: buildQueryCacheFingerprint({ kind: 'income', window: 12, ...queryFingerprintBase() }), ttl: 600, fn: () => data.getIncome({ window: 12 }) },
  { key: buildQueryCacheFingerprint({ kind: 'bills', days: 45, ...queryFingerprintBase() }), ttl: 600, fn: () => data.getBills({ days: 45 }) },
  { key: buildQueryCacheFingerprint({ kind: 'reimb', from: 'd', to: 'd', openOnly: false, ...queryFingerprintBase() }), ttl: 300, fn: () => data.getReimbursement({}) },
  { key: 'categories', ttl: 300, fn: () => data.getCategories() },
];

async function warmCache() {
  for (const { key, ttl, fn } of WARM_TARGETS) {
    try {
      await cachedActual(key, fn, ttl);
    } catch (e) {
      console.error(`warmCache ${key} failed:`, e.message);
    }
  }
}

// Session-only gate for the web app + static assets. /api/v1/* runs its own
// (session-OR-token) auth below so native clients can use a bearer token.
app.use((req, res, next) => {
  if (
    req.path === '/demo'
    || req.path.startsWith('/login')
    || req.path.startsWith('/auth/')
    || isVersionedApiPath(req.path)
    || isPublicBrowserAsset(req.path)
  ) return next();
  requireAuth(req, res, next);
});

app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(createBrowserStaticMiddleware({ publicRoot: path.join(__dirname, 'public') }));

// Demo mode for the legacy web API (runs after the passkey gate above).
app.use((req, res, next) => isVersionedApiPath(req.path)
  ? next()
  : validateLegacyMutationBoundary(req, res, next));
app.use(demoMiddleware(false));

// ---- Endpoint resolvers (shared by legacy /api and versioned /api/v1) -------
const monthOf = (req) => req.query.month;
const resolvers = {
  accounts: () => cachedActual('accounts', () => data.getAccounts()),
  today: () => cachedActual('today', () => data.getToday(), 30),
  transactions: (req) => {
    const { accountId, start, end, category, bucket } = req.query;
    const budgetOnly = req.query.budgetOnly === '1' || req.query.budgetOnly === 'true';
    const collapse = req.query.collapse === '1' || req.query.collapse === 'true';
    const today = todayYMD();
    const startDate = start || `${today.slice(0, 7)}-01`;
    const endDate = end || today;
    const key = buildQueryCacheFingerprint({
      kind: 'txns',
      accountId: accountId || 'all',
      startDate,
      endDate,
      category: category || 'all',
      bucket: bucket || 'none',
      budgetOnly: budgetOnly ? 'budget' : 'all',
      collapse: collapse ? 'c' : 'x',
      ...queryFingerprintBase(),
    });
    return cachedActual(key, () => data.getTransactions({ accountId, start: startDate, end: endDate, category, bucket, budgetOnly, collapse }), 120);
  },
  txnById: (req) => {
    const { id } = req.params;
    const { accountId, date } = req.query;
    return actualCoordinator.runRead(() => data.getTransactionById({ id, accountId, date }), { label: 'txnById' });
  },
  merchantHistory: (req) => {
    const { payee, months } = req.query;
    const span = months ? Number(months) : 12;
    const key = buildQueryCacheFingerprint({ kind: 'mhist', payee: (payee || '').toLowerCase(), months: span, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getMerchantHistory({ payee, months: span }), 180);
  },
  spending: (req) => {
    const start = req.query.start ? String(req.query.start) : undefined;
    const end = req.query.end ? String(req.query.end) : undefined;
    const key = buildQueryCacheFingerprint({
      kind: 'spending',
      month: monthOf(req) || 'current',
      start: start || '',
      end: end || '',
      ...queryFingerprintBase(),
    });
    return cachedActual(key, () => data.getSpending({ month: monthOf(req), start, end }), 180);
  },
  trends: (req) => {
    const months = Math.min(60, Math.max(3, parseInt(req.query.months, 10) || 12));
    const endMonth = req.query.endMonth ? String(req.query.endMonth) : '';
    const key = buildQueryCacheFingerprint({ kind: 'trends', months, endMonth: endMonth || 'current', ...queryFingerprintBase() });
    return cachedActual(key, () => data.getTrends({ months, endMonth: endMonth || undefined }), 600);
  },
  budgets: (req) => cachedActual(`budgets-${monthOf(req) || 'current'}`, () => data.getBudgets({ month: monthOf(req) }), 300),
  reimbursement: (req) => {
    const { from, to } = req.query;
    const openOnly = req.query.openOnly === '1' || req.query.openOnly === 'true';
    const key = buildQueryCacheFingerprint({ kind: 'reimb', from: from || 'd', to: to || 'd', openOnly, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getReimbursement({ from, to, openOnly }), 300);
  },
  review: (req) => loadReviewInbox(req),
  reimbursementLedger: (req) => cachedActual(`reimb-ledger-${monthOf(req) || 'current'}`, () => data.getReimbursementLedger({ month: monthOf(req) }), 180),
  repaymentSuggestions: (req) => {
    const { from, to } = req.query;
    const key = buildQueryCacheFingerprint({
      kind: 'reimb-suggest',
      from: from || 'd',
      to: to || 'd',
      ...queryFingerprintBase(),
    });
    return cachedActual(key, () => data.suggestRepayments({ from, to }), 120);
  },
  insights: (req) => cachedActual(`insights-${monthOf(req) || 'current'}`, () => data.getInsights({ month: monthOf(req) }), 300),
  categories: () => cachedActual('categories', () => data.getCategories()),
  recurring: (req) => {
    const window = Math.min(36, Math.max(6, parseInt(req.query.window, 10) || 18));
    if (req.query.debug === '1') return data.getRecurring({ window, debug: true, minDates: Math.max(1, parseInt(req.query.minDates, 10) || 3) });
    const key = buildQueryCacheFingerprint({ kind: 'recurring', window, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getRecurring({ window }), 600);
  },
  bills: (req) => {
    const days = Math.min(120, Math.max(7, parseInt(req.query.days, 10) || 45));
    const key = buildQueryCacheFingerprint({ kind: 'bills', days, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getBills({ days }), 600);
  },
  forecast: (req) => {
    const days = Math.min(180, Math.max(30, parseInt(req.query.days, 10) || 90));
    const key = buildQueryCacheFingerprint({ kind: 'forecast', days, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getForecast({ days }), 300);
  },
  income: (req) => {
    const window = Math.min(24, Math.max(6, parseInt(req.query.window, 10) || 12));
    const key = buildQueryCacheFingerprint({ kind: 'income', window, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getIncome({ window }), 600);
  },
  search: (req) => {
    const q = (req.query.q || '').toString();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const { start, end, cursor } = req.query;
    const key = buildQueryCacheFingerprint({
      kind: 'search',
      q,
      start: start || '',
      end: end || '',
      limit,
      cursor: cursor || '',
      generation: actualCoordinator.generation,
      ...queryFingerprintBase(),
    });
    return cachedActual(key, () => data.searchTransactions({ q, start, end, limit, cursor }), 120);
  },
  goals: () => cachedActual('goals', () => data.getGoals(), 120),
  tags: (req) => {
    const start = req.query.start ? String(req.query.start) : '';
    const end = req.query.end ? String(req.query.end) : '';
    const key = buildQueryCacheFingerprint({ kind: 'tags', start, end, ...queryFingerprintBase() });
    return cachedActual(key, () => data.getTags({ start: start || undefined, end: end || undefined }), 120);
  },
  rules: () => cachedLocal('rules', () => Promise.resolve({ ...data.getRules(), catalog: data.getCatalogDisplay() }), 120),
  manualAssets: () => cachedLocal('manual-assets', () => Promise.resolve(data.getManualAssets()), 120),
  investments: () => cachedLocal('investments', () => Promise.resolve(data.getInvestments()), 120),
  reports: (req) => cachedActual(`reports-${monthOf(req) || 'current'}`, () => data.getReports({ month: monthOf(req) }), 300),
};

const applyLocal = (operation, mutation) => operation
  ? operation.applyLocal(mutation)
  : mutation();
const syncAfterLocal = (operation) => operation
  ? operation.sync(() => data.syncNow())
  : data.syncNow();

async function finalizeBulkMutation(operation, mutate, { kind } = {}) {
  if (operation?.key && operation?.journalBinding?.fingerprint) {
    data.assertBulkOperationJournalAdmission({
      operationKey: operation.key,
      journalBinding: { ...operation.journalBinding, kind },
      kind,
    });
  }
  const localResult = await applyLocal(operation, mutate);
  if (localResult?.needsSync) {
    await syncAfterLocal(operation);
  }
  invalidateHttpCache();
  if (!operation?.key) return localResult;
  return data.getBulkOperationResult(operation.key) || localResult;
}

async function setRecurring(req, operation) {
  const { key, status, hidden, forced, isBill, categoryId, cancellation } = parseRecurringOverrideRequest(req);
  return runActualProjectionMutation(
    () => applyLocal(operation, () =>
      data.setRecurringOverride({ key, status, hidden, forced, isBill, categoryId, cancellation })),
  );
}
async function markRecurring(req, operation) {
  const { payee, isBill } = parse(schemas.markRecurring, req.body, 'recurring mark');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.markRecurring({ payee, isBill })),
  );
}
async function splitTxn(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { accountId, date, legs } = parse(schemas.splitTransaction, req.body, 'transaction split');
  data.assertTransactionMutationAvailable({
    ids: [id, ...legs.map((leg) => leg.id).filter(Boolean)],
  });
  const result = await applyLocal(operation, () => data.splitTransaction({ id, accountId, date, legs }));
  await syncAfterLocal(operation);
  invalidateHttpCache();
  return result;
}
async function unsplitTxn(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { accountId, date, categoryId } = parse(schemas.unsplitTransaction, req.body, 'transaction unsplit');
  data.assertTransactionMutationAvailable({ ids: [id] });
  const result = await applyLocal(operation, () => data.removeSplit({ id, accountId, date, categoryId }));
  await syncAfterLocal(operation);
  invalidateHttpCache();
  return result;
}
async function setPayeeH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { payee, isLeg, parentId, accountId, date } = parse(schemas.setPayee, req.body, 'payee update');
  data.assertTransactionMutationAvailable({
    ids: isLeg ? [parentId, id] : [id],
  });
  const result = await applyLocal(operation, () =>
    data.setPayee({ id, payee, isLeg, parentId, accountId, date }));
  await syncAfterLocal(operation);
  invalidateHttpCache();
  return result;
}
async function bankSyncH(_req, operation) {
  let result;
  if (operation) {
    // There is no pre-sync domain write for this action. Advance through a
    // durable no-op local checkpoint so sync_unknown precedes runBankSync too.
    operation.localApplied({ ok: true, bankSyncPending: true });
    await operation.sync(async () => {
      result = await data.bankSync({ throwOnBankError: true });
    });
  } else {
    result = await data.bankSync();
  }
  if (!result.ok) {
    invalidateHttpCache();
    return { ...result, phantom: { skipped: true, reason: 'bank sync did not complete' } };
  }
  const phantom = await data.cleanupPhantoms({ dryRun: true });
  invalidateHttpCache();
  return {
    ...result,
    phantom,
    automation: {
      applied: false,
      reason: 'bank sync imports data only; categorization and cleanup require explicit confirmation',
    },
  };
}
async function phantomCleanupH(req, operation) {
  const query = parsePhantomCleanupRequest(req);
  const dryRun = query.dryRun === '1' || query.dryRun === 'true';
  if (dryRun) {
    return applyLocal(operation, () => data.cleanupPhantoms({
      dryRun: true,
      window: query.window,
      agedDays: query.agedDays,
      observeDays: query.observeDays,
      holdAgedDays: query.holdAgedDays,
      holdObserveDays: query.holdObserveDays,
    }));
  }
  return finalizeBulkMutation(operation, () => data.cleanupPhantoms({
    window: query.window,
    agedDays: query.agedDays,
    observeDays: query.observeDays,
    holdAgedDays: query.holdAgedDays,
    holdObserveDays: query.holdObserveDays,
    operationKey: operation.key,
    journalBinding: operation.journalBinding,
  }), { kind: 'phantom_cleanup' });
}
const phantomLogH = (req) => Promise.resolve(data.getPhantomLog({ limit: Number(req.query.limit) || 100 }));
// Receipts
async function addReceiptH(req, operation) {
  const receipt = parseReceiptRequest(req);
  data.assertTransactionMutationAvailable({
    ids: [receipt.txnId],
  });
  try {
    await data.getTransactionById({
      id: receipt.txnId,
      accountId: receipt.accountId,
      date: receipt.transactionDate,
    });
  } catch (error) {
    if (operation && error instanceof AccountNotFoundError) {
      throw new KnownPreApplyError('Account not found', {
        code: 'ACCOUNT_NOT_FOUND',
        status: 404,
        cause: error,
      });
    }
    if (operation && error instanceof TransactionNotFoundError) {
      throw new KnownPreApplyError('Transaction not found', {
        code: 'TRANSACTION_NOT_FOUND',
        status: 404,
        cause: error,
      });
    }
    throw error;
  }
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.addReceipt(receipt)),
    'today', 'review-current',
  );
}
const receiptsH = (req) => Promise.resolve(data.getReceipts({ txnId: req.query.txnId }));
async function deleteReceiptH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'receipt id');
  data.assertReceiptMutationAvailable({ id });
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.deleteReceipt({ id })),
    'today', 'review-current',
  );
}
// Raw image stream (auth already enforced by the router). expo-image sends the
// token via headers, so this just serves the file bytes with the right type.
async function receiptImageH(req, res) {
  try {
    await withReadAdmission(req, res, actualCoordinator, async () => {
      const f = await Promise.resolve(data.getReceiptFile({ id: req.params.id }));
      if (!f) {
        sendApiErrorCode(req, res, 'NOT_FOUND');
        return;
      }
      const mime = String(f.mime || '').toLowerCase();
      const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
      if (!allowed.has(mime)) {
        sendApiError(req, res, new AppError('unsupported receipt image type', {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          status: 415,
          expose: true,
        }));
        return;
      }
      res.type(mime);
      res.setHeader('Content-Disposition', 'inline; filename="receipt-image"');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      await new Promise((resolve, reject) => {
        res.sendFile(f.path, (error) => (error ? reject(error) : resolve()));
      });
    }, { admission: requestAdmission });
  } catch (e) {
    if (!res.headersSent) return sendApiError(req, res, e);
  }
}
async function sweepReimbH(req, operation) {
  const { tags, from, to } = parse(schemas.reimbursementSweep, req.body, 'reimbursement sweep');
  const result = await applyLocal(operation, () => data.sweepReimbursementTags({ tags, from, to }));
  await syncAfterLocal(operation);
  invalidateHttpCache();
  return result;
}
async function deleteTxn(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { accountId, date } = parse(schemas.deleteTransactionQuery, req.query, 'transaction delete query');
  data.assertTransactionMutationAvailable({ ids: [id] });
  const result = await applyLocal(operation, () => data.deleteTransaction({ id, accountId, date }));
  await syncAfterLocal(operation); // persist the delete back to the Actual server
  invalidateHttpCache(); // removing a transaction shifts balances/spending/insights
  return result;
}
async function saveRuleH(req, operation) {
  const rule = parse(schemas.rule, req.body, 'categorization rule');
  return finalizeBulkMutation(operation, () => data.saveRule(rule, {
    sync: false,
    operationKey: operation.key,
    journalBinding: operation.journalBinding,
  }), { kind: 'rules_save' });
}
async function deleteRuleH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'rule id');
  const result = await applyLocal(operation, () => data.deleteRule({ id }));
  invalidateLocalCache('rules');
  return result;
}
async function applyRulesH(_req, operation) {
  return finalizeBulkMutation(operation, () => data.applyRules({
    sync: false,
    operationKey: operation.key,
    journalBinding: operation.journalBinding,
  }), { kind: 'rules_apply' });
}
async function syncSharesH(_req, operation) {
  await data.preflightSplitwiseMirrorShareSync();
  return finalizeBulkMutation(operation, () => data.syncSplitwiseShareExpenses({
    sync: false,
    operationKey: operation.key,
    journalBinding: { ...operation.journalBinding, kind: 'splitwise_mirror' },
  }), { kind: 'splitwise_mirror' });
}
async function eventsH() {
  return cachedActual('events', () => data.getEvents(), 60);
}
async function saveEventH(req, operation) {
  const event = parse(schemas.event, req.body, 'event');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.saveEvent(event)),
    'events',
  );
}
async function deleteEventH(req, operation) {
  const { slug } = parse(schemas.slugParam, req.params, 'event slug');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.deleteEvent({ slug })),
    'events',
  );
}
async function setAccountOverrideH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'account id');
  const body = parse(schemas.accountOverride, req.body, 'account override');
  const {
    name,
    hidden,
    role,
    creditLiabilityCoverage,
    paymentRecurringKey,
    fundingAccountId,
    statement,
    clearCreditLiability,
  } = body;
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.setAccountOverride({
      id,
      name,
      hidden,
      role,
      creditLiabilityCoverage,
      paymentRecurringKey,
      fundingAccountId,
      statement,
      clearCreditLiability,
    })),
    'accounts', 'today', 'forecast', 'trends', 'spending', 'goals', 'review', 'reports', 'insights',
  );
}
async function setReviewDispositionH(req, operation) {
  const disposition = parse(schemas.reviewDisposition, req.body, 'review disposition');
  return runActualProjectionMutation(async () => {
    const admission = await data.prepareReviewDispositionAdmission(disposition);
    return applyLocal(operation, () => data.commitReviewDisposition(admission));
  }, 'today', 'review-current');
}
async function saveManualAssetH(req, operation) {
  const asset = parse(schemas.manualAsset, req.body, 'manual asset');
  const result = await applyLocal(operation, () => data.saveManualAsset(asset));
  invalidateLocalCache('manual-assets');
  return result;
}
async function deleteManualAssetH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'manual asset id');
  const result = await applyLocal(operation, () => data.deleteManualAsset({ id }));
  invalidateLocalCache('manual-assets');
  return result;
}
async function setNotes(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { notes, isLeg, parentId, accountId, date } = parse(schemas.setNotes, req.body, 'notes update');
  data.assertTransactionMutationAvailable({
    ids: isLeg ? [parentId, id] : [id],
  });
  const result = await applyLocal(operation, () =>
    data.setTransactionNotes({ id, notes, isLeg, parentId, accountId, date }));
  await syncAfterLocal(operation);
  invalidateHttpCache();
  return result;
}
async function setDateH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { date, isLeg } = parse(schemas.setDate, req.body, 'date update');
  data.assertTransactionMutationAvailable({ ids: [id] });
  const result = await applyLocal(operation, () => data.setTransactionDate({ id, date, isLeg }));
  await syncAfterLocal(operation);
  invalidateHttpCache();
  return result;
}
async function saveGoal(req, operation) {
  const goal = parse(schemas.goal, req.body, 'goal');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.saveGoal(goal)),
    'goals', 'today',
  );
}
async function deleteGoal(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'goal id');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.deleteGoal(id)),
    'goals', 'today',
  );
}

async function setCategory(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'transaction id');
  const { categoryId, isLeg, parentId, accountId, date } = parse(schemas.setCategory, req.body, 'category update');
  data.assertTransactionMutationAvailable({
    ids: isLeg ? [parentId, id] : [id],
  });
  const result = await applyLocal(operation, () =>
    data.setTransactionCategory({ id, categoryId, isLeg, parentId, accountId, date }));
  await syncAfterLocal(operation); // persist the write back to the Actual server
  invalidateHttpCache();
  return result;
}
// Manual refresh: pull the latest deltas from the Actual server, clear stale
// HTTP cache, then immediately re-warm the hot keys so the UI repopulates fast.
async function doRefresh(operation) {
  // Refresh has no domain mutation. A durable no-op local checkpoint still
  // precedes sync so a crash or timeout cannot cause an automatic second sync.
  if (operation) operation.localApplied({ ok: true, refreshPending: true });
  await syncAfterLocal(operation);
  // Detect split deltas without changing the user's allocation.
  const splits = await data.reconcileSplits();
  const phantom = await data.cleanupPhantoms({ dryRun: true });
  await warmCache();
  return {
    ok: true,
    splits,
    phantom,
    automation: {
      applied: false,
      reason: 'refresh is read-only; financial mutations require explicit endpoints',
    },
  };
}

async function markBill(req, operation) {
  const { id, key, dueDate, paid } = parse(schemas.markBill, req.body, 'bill state');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.setBillPaid({ id, key, dueDate, paid })),
  );
}

async function setOwes(req, operation) {
  const config = parse(schemas.owesConfig, req.body, 'reimbursement configuration');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.setOwesConfig(config)),
  );
}

async function createTxn(req, operation) {
  const transaction = parse(schemas.createTransaction, req.body, 'transaction');
  const result = await applyLocal(operation, () => data.createTransaction(transaction, { sync: false }));
  await syncAfterLocal(operation);
  invalidateHttpCache(); // a new transaction shifts balances/spending/insights
  return result;
}

async function setBudget(req, operation) {
  const { month, categoryId, amount } = parse(schemas.budget, req.body, 'budget amount');
  const result = await applyLocal(operation, () => data.setBudgetAmount({ month, categoryId, amount }));
  await syncAfterLocal(operation); // persist the write back to the Actual server
  invalidateHttpCache(); // budget targets feed budgets + insights
  return result;
}

const reimbLinks = (req) => data.getReimbLinks({ id: req.query.id });
async function addLink(req, operation) {
  const link = parse(schemas.reimbLink, req.body, 'reimbursement link');
  data.assertTransactionMutationAvailable({ ids: [link.inflow?.id, link.expense?.id] });
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.addReimbLink({ ...link, operationIdentity: operation?.key })),
  );
}
async function confirmRepaymentH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'repayment id');
  const from = req.query.from;
  const to = req.query.to;
  data.assertTransactionMutationAvailable({ ids: [id.startsWith('sg_') ? id.slice(3) : null] });
  const admission = await data.validateRepaymentConfirmationAdmission({ id, from, to });
  const r = await applyLocal(operation, () =>
    data.confirmRepayment({
      id,
      from,
      to,
      operationIdentity: operation?.key,
      admission,
    }));
  await syncAfterLocal(operation); // persist the inflow's new category to the Actual server
  invalidateHttpCache();
  return r;
}
async function dismissRepaymentH(req, operation) {
  const { id } = parse(schemas.idParam, req.params, 'repayment id');
  const inflowId = req.body?.inflowId == null
    ? undefined
    : parse(schemas.idParam, { id: req.body.inflowId }, 'repayment inflow id').id;
  data.assertTransactionMutationAvailable({
    ids: [inflowId || (id.startsWith('sg_') ? id.slice(3) : null)],
  });
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.dismissRepayment({ id, inflowId })),
  );
}
async function delLink(req, operation) {
  const inflowId = (req.body && req.body.inflowId) || req.query.inflowId;
  const expenseId = (req.body && req.body.expenseId) || req.query.expenseId;
  const expectedVersionRaw = (req.body && req.body.expectedVersion) ?? req.query.expectedVersion;
  const parsed = parse(schemas.deleteReimbLink, {
    inflowId,
    expenseId,
    ...(expectedVersionRaw != null && expectedVersionRaw !== ''
      ? { expectedVersion: Number(expectedVersionRaw) }
      : {}),
  }, 'reimbursement unlink');
  data.assertTransactionMutationAvailable({ ids: [parsed.inflowId, parsed.expenseId] });
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.deleteReimbLink({
      ...parsed,
      operationIdentity: operation?.key,
    })),
  );
}

// Reconciliation — read fresh (not cached) so checkboxes reflect instantly.
const reconciliationH = (req) => data.getReconciliation({ month: monthOf(req) });
const reconcilePendingH = () => data.getReconcilePending();
const setReconItemH = (req, operation) => {
  const item = parse(schemas.reconcileItem, req.body, 'reconciliation item');
  data.assertTransactionMutationAvailable({ ids: [item.id] });
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.setReconcileItem(item)),
    'today', 'review-current',
  );
};
const setReconMonthH = (req, operation) => {
  const month = parse(schemas.reconcileMonth, req.body, 'reconciliation month');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.setReconcileMonth(month)),
    'today', 'review-current',
  );
};
const setReconEnabledH = (req, operation) => {
  const setting = parse(schemas.reconcileEnabled, req.body, 'reconciliation setting');
  return runActualProjectionMutation(
    () => applyLocal(operation, () => data.setReconcileEnabled(setting)),
    'today', 'review-current',
  );
};

async function reimbursementExport(req, res) {
  try {
    await withReadAdmission(req, res, actualCoordinator, async () => {
      const { from, to } = req.query;
      const strict = req.query.strict === '1' || req.query.strict === 'true';
      const format = String(req.query.format || 'json').toLowerCase();
      const payload = await data.buildReimbursementExport({
        from,
        to,
        strict,
        releaseManifestPath: RELEASE_MANIFEST_PATH,
      });
      const exitCode = exportExitCode(payload);
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="reimbursement-export.csv"');
        res.send(formatReimbursementExportCsv(payload));
        return;
      }
      if (format === 'human') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(formatReimbursementExportHuman(payload));
        return;
      }
      const isV1 = req.baseUrl === '/api/v1';
      if (isV1) {
        res.type('application/json').send(`${buildReimbursementExportV1Envelope(payload)}\n`);
        return;
      }
      res.setHeader('X-Reimbursement-Export-Status', payload.completeness.status);
      res.setHeader('X-Reimbursement-Export-Exit-Code', String(exitCode));
      res.setHeader('X-Reimbursement-Export-Authoritative', String(payload.totals.authoritative));
      res.type('application/json').send(stableStringify(payload));
    }, { admission: requestAdmission });
  } catch (e) { sendApiError(req, res, e); }
}

// Monthly CSV export (raw text/csv, used by web download + app share sheet).
function csvEscape(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s.trimStart())) s = `'${s}`;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function reportCsv(req, res) {
  const abort = createClientAbortSignal(req, res);
  try {
    let stats;
    await runWithQueryInstrumentation(async (activeStats) => {
      stats = activeStats;
      await withReadAdmission(req, res, actualCoordinator, async () => {
        const rep = await data.getMonthlyReport({ month: req.query.month });
        const net = Math.round((rep.summary.totalIncome - rep.summary.totalSpend) * 100) / 100;
        const lines = [
          `Monthly report,${rep.month}`,
          `Total income,${rep.summary.totalIncome}`,
          `Total spend,${rep.summary.totalSpend}`,
          `Net,${net}`,
          '',
          'Date,Payee,Account,Category,Amount,Notes',
        ];
        for (const t of rep.transactions) {
          lines.push([t.date, csvEscape(t.payee), csvEscape(t.account), csvEscape(t.category || ''), t.amount, csvEscape(t.notes || '')].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="finance-${rep.month}.csv"`);
        res.send(lines.join('\n'));
      }, { admission: requestAdmission, signal: abort.signal });
    }, { signal: abort.signal });
    attachQueryStatsHeaders(res, stats);
  } catch (e) {
    if (!res.headersSent) sendApiError(req, res, e);
  } finally {
    abort.dispose();
  }
}

// Raw responders for the legacy web API; enveloped {data}/{error} responders for v1.
const runHandler = (req, res, fn, operation, { signal } = {}) => {
  if (operation) return fn(req, operation);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return withMutationAdmission(req, res, operationJournal, mutationQueue, () => fn(req), {
      isDemo,
      admission: requestAdmission,
    });
  }
  return withReadAdmission(req, res, actualCoordinator, () => fn(req), { admission: requestAdmission, signal });
};
async function executeReadWithQueryStats(req, res, fn) {
  const abort = createClientAbortSignal(req, res);
  let stats;
  try {
    const payload = await runWithQueryInstrumentation(async (activeStats) => {
      stats = activeStats;
      return runHandler(req, res, fn, undefined, { signal: abort.signal });
    }, { signal: abort.signal });
    return { payload, stats };
  } finally {
    abort.dispose();
  }
}
const raw = (fn) => async (req, res) => {
  try {
    const { payload, stats } = await executeReadWithQueryStats(req, res, fn);
    attachQueryStatsHeaders(res, stats);
    res.json(payload);
  } catch (e) {
    if (!res.headersSent) sendApiError(req, res, e);
  }
};
function operationJournalError(error, phase) {
  runtimeHealth.fatalErrorAt = new Date().toISOString();
  console.error(`[operation-journal:${phase}]`, error);
}

function bulkJournalProofFromOperation(operation) {
  if (!operation?.fingerprint || operation.fingerprintVersion == null) return null;
  return {
    fingerprint: operation.fingerprint,
    fingerprintVersion: operation.fingerprintVersion,
    method: operation.method || null,
    route: operation.route || null,
  };
}

async function bulkTerminalProofResolver({ key, operation }) {
  const journalOperation = bulkJournalProofFromOperation(operation);
  if (!journalOperation) return null;
  const result = data.proveBulkOperationJournalCompletion(key, journalOperation);
  if (!result?.ok || result.status !== 'completed' || result.needsSync) return null;
  return {
    result,
    fingerprint: journalOperation.fingerprint,
    fingerprintVersion: journalOperation.fingerprintVersion,
  };
}

async function readOperationStatus(req, res, key) {
  return withOperationStatusAdmission(req, res, mutationQueue, () => reconcileOperationJournalFromProof(operationJournal, key, {
    proofResolver: bulkTerminalProofResolver,
    onJournalError: operationJournalError,
  }), { admission: requestAdmission });
}

async function executeVersionedMutation(req, fn, mutationRoute) {
  const idempotencyKey = req.get('Idempotency-Key');
  return executeJournaledOperation({
    journal: operationJournal,
    key: idempotencyKey,
    request: {
      method: req.method,
      path: `${req.baseUrl || ''}${req.path || ''}` || req.path,
      url: req.originalUrl,
      body: req.body,
    },
    preApplyValidate: () => validateVersionedMutationRequest(req),
    handler: (operation) => fn(req, operation),
    requiresCheckpoint: mutationRoute.requiresCheckpoint,
    onJournalError: operationJournalError,
    terminalProofResolver: bulkTerminalProofResolver,
  });
}
const env = (fn, mutationRoute = null) => async (req, res) => {
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const versioned = isVersionedApiRequest(req);
  try {
    if (mutation && versioned && !isDemo(req)) {
      if (!mutationRoute) {
        throw new AppError('Versioned mutation route is missing lifecycle classification', {
          code: 'MUTATION_LIFECYCLE_UNCLASSIFIED',
          status: 500,
          expose: true,
        });
      }
      const execution = await withMutationAdmission(
        req,
        res,
        operationJournal,
        mutationQueue,
        () => executeVersionedMutation(req, fn, mutationRoute),
        { isDemo, isVersioned: true, admission: requestAdmission },
      );
      return res.json({ data: execution.result, operation: execution.operation });
    }
    let stats;
    const abort = createClientAbortSignal(req, res);
    try {
      const result = await runWithQueryInstrumentation(async (activeStats) => {
        stats = activeStats;
        return runHandler(req, res, fn, undefined, { signal: abort.signal });
      }, { signal: abort.signal });
      attachQueryStatsHeaders(res, stats);
      return res.json({ data: result });
    } finally {
      abort.dispose();
    }
  } catch (e) {
    if (!res.headersSent) return sendApiError(req, res, e);
  }
};

// ---- Legacy unversioned API (web dashboard, passkey session) ----------------
app.get('/api/accounts', raw(resolvers.accounts));
app.get('/api/transactions', raw(resolvers.transactions));
app.post('/api/transactions', raw(createTxn));
app.get('/api/spending', raw(resolvers.spending));
app.get('/api/trends', raw(resolvers.trends));
app.get('/api/budgets', raw(resolvers.budgets));
app.post('/api/budgets', raw(setBudget));
app.get('/api/reimbursement', raw(resolvers.reimbursement));
app.get('/api/reimbursement-ledger', raw(resolvers.reimbursementLedger));
app.get('/api/reimbursement-export', reimbursementExport);
app.get('/api/insights', raw(resolvers.insights));
app.get('/api/merchant-history', raw(resolvers.merchantHistory));
app.get('/api/categories', raw(resolvers.categories));
app.get('/api/recurring', raw(resolvers.recurring));
app.get('/api/bills', raw(resolvers.bills));
app.get('/api/income', raw(resolvers.income));
app.get('/api/search', raw(resolvers.search));
app.get('/api/tags', raw(resolvers.tags));
app.get('/api/report.csv', reportCsv);
app.get('/api/goals', raw(resolvers.goals));
app.get('/api/transactions/:id', raw(resolvers.txnById));
app.post('/api/transactions/:id/category', raw(setCategory));
app.post('/api/transactions/:id/notes', raw(setNotes));
app.post('/api/transactions/:id/date', raw(setDateH));
app.post('/api/transactions/:id/payee', raw(setPayeeH));
app.post('/api/transactions/:id/split', raw(splitTxn));
app.post('/api/transactions/:id/unsplit', raw(unsplitTxn));
app.delete('/api/transactions/:id', raw(deleteTxn));
app.post('/api/bank-sync', raw(bankSyncH));
app.post('/api/reimbursements/sweep', raw(sweepReimbH));
app.post('/api/phantom/cleanup', raw(phantomCleanupH));
app.get('/api/phantom/log', raw(phantomLogH));
app.post('/api/receipts', raw(addReceiptH));
app.get('/api/receipts', raw(receiptsH));
app.get('/api/receipts/:id/image', receiptImageH);
app.delete('/api/receipts/:id', raw(deleteReceiptH));
app.get('/api/rules', raw(resolvers.rules));
app.post('/api/rules', raw(saveRuleH));
app.post('/api/rules/apply', raw(applyRulesH));
app.delete('/api/rules/:id', raw(deleteRuleH));
app.post('/api/accounts/:id/override', raw(setAccountOverrideH));
app.get('/api/manual-assets', raw(resolvers.manualAssets));
app.post('/api/manual-assets', raw(saveManualAssetH));
app.delete('/api/manual-assets/:id', raw(deleteManualAssetH));
app.post('/api/recurring/:key/override', raw(setRecurring));
app.post('/api/recurring/mark', raw(markRecurring));
app.post('/api/bills/paid', raw(markBill));
app.get('/api/owes-config', raw(async () => data.getOwesConfig()));
app.post('/api/owes-config', raw(setOwes));
app.get('/api/reimb-links', raw(reimbLinks));
app.post('/api/reimb-links', raw(addLink));
app.delete('/api/reimb-links', raw(delLink));
app.get('/api/repayments/suggestions', raw(resolvers.repaymentSuggestions));
app.post('/api/repayments/:id/confirm', raw(confirmRepaymentH));
app.post('/api/repayments/:id/dismiss', raw(dismissRepaymentH));
app.get('/api/reconciliation', raw(reconciliationH));
app.get('/api/reconciliation/pending', raw(reconcilePendingH));
app.post('/api/reconciliation/item', raw(setReconItemH));
app.post('/api/reconciliation/month', raw(setReconMonthH));
app.post('/api/reconciliation/enabled', raw(setReconEnabledH));
app.post('/api/goals', raw(saveGoal));
app.delete('/api/goals/:id', raw(deleteGoal));
app.post('/api/refresh', raw(async () => doRefresh()));

// ---- Versioned API for native clients: session OR bearer token + CORS -------
const API_TOKEN = process.env.FINANCE_API_TOKEN || '';
function tokenOk(presented) {
  if (!API_TOKEN || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function v1Auth(req, res, next) {
  if (isDemo(req)) return next(); // public sample data only; demoMiddleware handles the response.
  if (req.session && req.session.authenticated) return next(); // browser (passkey)
  const headerTok = req.get('X-Finance-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (tokenOk(headerTok)) return next(); // native app (token)
  return sendApiErrorCode(req, res, 'UNAUTHENTICATED');
}

const v1 = express.Router();
v1.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && origin !== ORIGIN) return sendApiErrorCode(req, res, 'CORS_ORIGIN_REJECTED');
  if (origin === ORIGIN) res.header('Access-Control-Allow-Origin', ORIGIN);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Finance-Token, X-Demo-Mode, Idempotency-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
v1.use(v1Auth);
v1.use((req, res, next) => {
  if (!isDemo(req) || !['POST', 'DELETE'].includes(req.method)) return next();
  try {
    validateVersionedMutationRequest(req);
    return next();
  } catch (error) {
    return sendApiError(req, res, error);
  }
});
v1.use(demoMiddleware(true)); // demo mode for native clients (after token/session auth)
const registeredV1MutationRoutes = new Set();
function registerV1Mutation(method, route, handler) {
  const definition = getMutationRoute(method, route);
  if (!definition) throw new Error(`Unclassified versioned mutation route: ${method} ${route}`);
  const key = routeKey(method, route);
  if (registeredV1MutationRoutes.has(key)) throw new Error(`Duplicate versioned mutation route: ${key}`);
  registeredV1MutationRoutes.add(key);
  v1[method.toLowerCase()](route, env(handler, definition));
}
v1.get('/operations/:key', env(async (req, res) => {
  const operation = await readOperationStatus(req, res, req.params.key);
  if (!operation) {
    throw new AppError('Operation not found', {
      code: 'OPERATION_NOT_FOUND',
      status: 404,
      expose: true,
    });
  }
  return operation;
}));
v1.get('/ping', env(async () => {
  const actual = data.getHealth();
  if (runtimeHealth.fatalErrorAt || !actual.ready) {
    throw new AppError('Finance data is not ready', {
      code: 'NOT_READY',
      status: 503,
      expose: true,
    });
  }
  return {
    ok: true,
    ts: Date.now(),
    startedAt: runtimeHealth.startedAt,
    financeTimeZone: FINANCE_TIME_ZONE,
    actual,
    actualCoordinator: actualCoordinator.getHealth(),
    requestAdmission: requestAdmission.getHealth(),
    queuedMutations: mutationQueue.size,
    release: releaseIdentity(),
  };
}));
v1.get('/reconnect-freshness', env(async (req) => {
  const actual = data.getHealth();
  if (runtimeHealth.fatalErrorAt || !actual.ready) {
    throw new AppError('Finance data is not ready', {
      code: 'NOT_READY',
      status: 503,
      expose: true,
    });
  }
  const principal = deriveRequestPrincipal(req, {
    apiToken: process.env.FINANCE_API_TOKEN || '',
    selftest: SELFTEST,
  });
  return reconnectFreshnessProbe.runProbe(principal);
}));
v1.get('/accounts', env(resolvers.accounts));
v1.get('/today', env(resolvers.today));
v1.get('/transactions', env(resolvers.transactions));
registerV1Mutation('POST', '/transactions', createTxn);
v1.get('/spending', env(resolvers.spending));
v1.get('/trends', env(resolvers.trends));
v1.get('/budgets', env(resolvers.budgets));
registerV1Mutation('POST', '/budgets', setBudget);
v1.get('/reimbursement', env(resolvers.reimbursement));
v1.get('/review', env(resolvers.review));
registerV1Mutation('POST', '/review/dispositions', setReviewDispositionH);
v1.get('/reimbursement-ledger', env(resolvers.reimbursementLedger));
v1.get('/reimbursement-export', reimbursementExport);
v1.get('/insights', env(resolvers.insights));
v1.get('/merchant-history', env(resolvers.merchantHistory));
v1.get('/categories', env(resolvers.categories));
v1.get('/recurring', env(resolvers.recurring));
v1.get('/bills', env(resolvers.bills));
v1.get('/forecast', env(resolvers.forecast));
v1.get('/income', env(resolvers.income));
v1.get('/search', env(resolvers.search));
v1.get('/tags', env(resolvers.tags));
v1.get('/report.csv', reportCsv);
v1.get('/goals', env(resolvers.goals));
v1.get('/transactions/:id', env(resolvers.txnById));
registerV1Mutation('POST', '/transactions/:id/category', setCategory);
registerV1Mutation('POST', '/transactions/:id/notes', setNotes);
registerV1Mutation('POST', '/transactions/:id/date', setDateH);
registerV1Mutation('POST', '/transactions/:id/payee', setPayeeH);
registerV1Mutation('POST', '/transactions/:id/split', splitTxn);
registerV1Mutation('POST', '/transactions/:id/unsplit', unsplitTxn);
registerV1Mutation('DELETE', '/transactions/:id', deleteTxn);
registerV1Mutation('POST', '/bank-sync', bankSyncH);
registerV1Mutation('POST', '/reimbursements/sweep', sweepReimbH);
registerV1Mutation('POST', '/phantom/cleanup', phantomCleanupH);
v1.get('/phantom/log', env(phantomLogH));
registerV1Mutation('POST', '/receipts', addReceiptH);
v1.get('/receipts', env(receiptsH));
v1.get('/receipts/:id/image', receiptImageH); // raw bytes (auth via router)
registerV1Mutation('DELETE', '/receipts/:id', deleteReceiptH);
v1.get('/rules', env(resolvers.rules));
registerV1Mutation('POST', '/rules', saveRuleH);
registerV1Mutation('POST', '/rules/apply', applyRulesH);
registerV1Mutation('DELETE', '/rules/:id', deleteRuleH);
registerV1Mutation('POST', '/splitwise/sync-shares', syncSharesH);
v1.get('/events', env(eventsH));
registerV1Mutation('POST', '/events', saveEventH);
registerV1Mutation('DELETE', '/events/:slug', deleteEventH);
registerV1Mutation('POST', '/accounts/:id/override', setAccountOverrideH);
v1.get('/manual-assets', env(resolvers.manualAssets));
v1.get('/investments', env(resolvers.investments));
v1.get('/reports', env(resolvers.reports));
registerV1Mutation('POST', '/manual-assets', saveManualAssetH);
registerV1Mutation('DELETE', '/manual-assets/:id', deleteManualAssetH);
registerV1Mutation('POST', '/recurring/:key/override', setRecurring);
registerV1Mutation('POST', '/recurring/mark', markRecurring);
registerV1Mutation('POST', '/bills/paid', markBill);
v1.get('/owes-config', env(async () => data.getOwesConfig()));
registerV1Mutation('POST', '/owes-config', setOwes);
v1.get('/reimb-links', env(reimbLinks));
registerV1Mutation('POST', '/reimb-links', addLink);
registerV1Mutation('DELETE', '/reimb-links', delLink);
v1.get('/repayments/suggestions', env(resolvers.repaymentSuggestions));
registerV1Mutation('POST', '/repayments/:id/confirm', confirmRepaymentH);
registerV1Mutation('POST', '/repayments/:id/dismiss', dismissRepaymentH);
v1.get('/reconciliation', env(reconciliationH));
v1.get('/reconciliation/pending', env(reconcilePendingH));
registerV1Mutation('POST', '/reconciliation/item', setReconItemH);
registerV1Mutation('POST', '/reconciliation/month', setReconMonthH);
registerV1Mutation('POST', '/reconciliation/enabled', setReconEnabledH);
registerV1Mutation('POST', '/goals', saveGoal);
registerV1Mutation('DELETE', '/goals/:id', deleteGoal);
registerV1Mutation('POST', '/refresh', (_req, operation) => doRefresh(operation));
if (process.env.NODE_ENV === 'test') {
  const {
    getQueryAbortSentinelSnapshot,
    resetQueryAbortSentinel,
  } = require('./lib/query-abort-sentinel');
  v1.get('/test/query-scaling-state', env(async () => {
    let callLog = [];
    try {
      const fixturePath = process.env.ACTUAL_API_PATH;
      if (fixturePath) {
        const fixture = require(fixturePath);
        if (Array.isArray(fixture.state?.callLog)) {
          callLog = fixture.state.callLog.map((entry) => ({ ...entry }));
        }
      }
    } catch (_) { /* fixture unavailable */ }
    return {
      callLog,
      abortSentinel: getQueryAbortSentinelSnapshot(),
    };
  }));
  v1.get('/test/query-scaling-events', env(async () => data.getEvents()));
  v1.get('/test/query-scaling-reset', env(async () => {
    try {
      const fixturePath = process.env.ACTUAL_API_PATH;
      if (fixturePath) {
        const fixture = require(fixturePath);
        if (typeof fixture.reset === 'function') {
          fixture.reset({
            accountCount: Number(process.env.FINANCE_QUERY_TEST_ACCOUNT_COUNT || 6),
            rowsPerAccount: Number(process.env.FINANCE_QUERY_TEST_ROWS_PER_ACCOUNT || 40),
            anchorMonth: '2024-06',
            yearSpan: 1,
          });
        }
      }
    } catch (_) { /* fixture unavailable */ }
    resetQueryAbortSentinel();
    return { ok: true };
  }));
  v1.get('/test/query-scaling-throw', env(async () => {
    throw new AppError('Intentional handler failure', {
      code: 'TEST_HANDLER_ERROR',
      status: 500,
      expose: true,
    });
  }));
}
const missingV1MutationRoutes = MUTATION_ROUTES
  .filter(({ method, path: route }) => !registeredV1MutationRoutes.has(routeKey(method, route)));
if (missingV1MutationRoutes.length) {
  throw new Error(`Unregistered versioned mutation routes: ${missingV1MutationRoutes.map(({ method, path: route }) => `${method} ${route}`).join(', ')}`);
}
v1.use((req, res) => {
  if (versionedRouteExists(req)) return sendApiErrorCode(req, res, 'METHOD_NOT_ALLOWED');
  return sendApiErrorCode(req, res, 'NOT_FOUND');
});
app.use('/api/v1', v1);
app.use(apiErrorMiddleware());

// ---- Freshness: keep the local Actual cache in sync with the server ---------
const SYNC_INTERVAL_MS = 10 * 60 * 1000; // every 10 min
async function periodicSync() {
  try {
    await mutationQueue.run(async () => {
      await data.syncNow();
      await warmCache(); // repopulate hot keys so the next request isn't a cold recompute
    });
  } catch (e) {
    console.error('Periodic sync failed:', e.message);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 5007;
const DEMO_ONLY = process.env.DEMO_ONLY === '1';
let periodicSyncTimer;
const httpServer = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Finance dashboard running on http://127.0.0.1:${PORT}`);
  if (DEMO_ONLY) {
    console.log('Demo-only mode enabled; skipping Actual startup sync');
    setInterval(() => {}, 60 * 60 * 1000);
    return;
  }
  data.initApi()
    .then(async () => {
      await warmCache(); // pre-warm once at startup so the first page loads are fast
      periodicSyncTimer = setInterval(periodicSync, SYNC_INTERVAL_MS);
    })
    .catch(e => {
      runtimeHealth.fatalErrorAt = new Date().toISOString();
      console.error('Initial API load failed:', e.message);
      if (process.env.NODE_ENV !== 'test') process.exit(1);
    });
});

bindGracefulShutdownSignals({
  httpServer,
  mutationQueue,
  requestAdmission,
  shutdownApi: () => data.shutdownApi(),
  stopPeriodicSync: () => {
    if (periodicSyncTimer) clearInterval(periodicSyncTimer);
  },
});
