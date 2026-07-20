const { RequestValidationError } = require('./errors');
const { parse, schemas } = require('./validation');
const { assertReceiptEncodedWithinLimits } = require('./receipt-limits');

function normalizeMutationPath(req) {
  const raw = req.path || '/';
  return raw.replace(/^\/api(?:\/v1)?(?=\/|$)/i, '') || '/';
}

function hasNonEmptyBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body).length > 0;
}

function assertEmptyBody(req, label) {
  if (hasNonEmptyBody(req)) {
    throw new RequestValidationError(`Invalid ${label}: request body is not allowed`, [{
      path: 'body',
      message: 'request body is not allowed',
    }]);
  }
}

function assertStrictEmptyQuery(req, label) {
  const keys = Object.keys(req.query || {});
  if (keys.length > 0) {
    throw new RequestValidationError(`Invalid ${label}: query parameters are not allowed`, [{
      path: 'query',
      message: 'query parameters are not allowed',
    }]);
  }
}

function assertNoPayload(req, label) {
  assertEmptyBody(req, label);
  assertStrictEmptyQuery(req, label);
}

function assertQueryOnly(req, label, schema, queryLabel) {
  assertEmptyBody(req, label);
  return parse(schema, req.query, queryLabel);
}

function parsePhantomCleanupRequest(req) {
  return assertQueryOnly(
    req,
    'phantom cleanup',
    schemas.phantomCleanupQuery,
    'phantom cleanup query',
  );
}

function parseRecurringOverrideRequest(req) {
  const { key } = parse(schemas.keyParam, req.params, 'recurring key');
  const body = parse(schemas.recurringOverride, req.body, 'recurring override');
  return { key, ...body };
}

function parseReceiptRequest(req) {
  if (req.body?.imageBase64 != null) assertReceiptEncodedWithinLimits(req.body.imageBase64);
  return parse(schemas.receipt, req.body, 'receipt');
}

function assertParamsOnlyDelete(req, label) {
  assertEmptyBody(req, label);
  assertStrictEmptyQuery(req, label);
}

const MUTATION_CONTRACTS = [
  {
    method: 'POST',
    pattern: /^\/transactions\/?$/i,
    validate: (req) => parse(schemas.createTransaction, req.body, 'transaction'),
  },
  {
    method: 'POST',
    pattern: /^\/budgets\/?$/i,
    validate: (req) => parse(schemas.budget, req.body, 'budget amount'),
  },
  {
    method: 'POST',
    pattern: /^\/review\/dispositions\/?$/i,
    validate: (req) => parse(schemas.reviewDisposition, req.body, 'review disposition'),
  },
  {
    method: 'POST',
    pattern: /^\/transactions\/([^/]+)\/category\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      return parse(schemas.setCategory, req.body, 'category update');
    },
  },
  {
    method: 'POST',
    pattern: /^\/transactions\/([^/]+)\/notes\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      return parse(schemas.setNotes, req.body, 'notes update');
    },
  },
  {
    method: 'POST',
    pattern: /^\/transactions\/([^/]+)\/date\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      return parse(schemas.setDate, req.body, 'date update');
    },
  },
  {
    method: 'POST',
    pattern: /^\/transactions\/([^/]+)\/payee\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      return parse(schemas.setPayee, req.body, 'payee update');
    },
  },
  {
    method: 'POST',
    pattern: /^\/transactions\/([^/]+)\/split\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      return parse(schemas.splitTransaction, req.body, 'transaction split');
    },
  },
  {
    method: 'POST',
    pattern: /^\/transactions\/([^/]+)\/unsplit\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      return parse(schemas.unsplitTransaction, req.body, 'transaction unsplit');
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/transactions\/([^/]+)\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'transaction id');
      parse(schemas.deleteTransactionQuery, req.query, 'transaction delete query');
      if (hasNonEmptyBody(req)) {
        parse(schemas.deleteTransactionBody, req.body, 'transaction delete body');
      }
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/bank-sync\/?$/i,
    validate: (req) => {
      assertNoPayload(req, 'bank sync');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/reimbursements\/sweep\/?$/i,
    validate: (req) => parse(schemas.reimbursementSweep, req.body, 'reimbursement sweep'),
  },
  {
    method: 'POST',
    pattern: /^\/phantom\/cleanup\/?$/i,
    validate: (req) => parsePhantomCleanupRequest(req),
  },
  {
    method: 'POST',
    pattern: /^\/receipts\/?$/i,
    validate: (req) => parseReceiptRequest(req),
  },
  {
    method: 'DELETE',
    pattern: /^\/receipts\/([^/]+)\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'receipt id');
      assertParamsOnlyDelete(req, 'receipt delete');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/rules\/?$/i,
    validate: (req) => parse(schemas.rule, req.body, 'categorization rule'),
  },
  {
    method: 'POST',
    pattern: /^\/rules\/apply\/?$/i,
    validate: (req) => {
      assertNoPayload(req, 'rules apply');
      return null;
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rules\/([^/]+)\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'rule id');
      assertParamsOnlyDelete(req, 'rule delete');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/splitwise\/sync-shares\/?$/i,
    validate: (req) => {
      assertNoPayload(req, 'splitwise sync');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/events\/?$/i,
    validate: (req) => parse(schemas.event, req.body, 'event'),
  },
  {
    method: 'DELETE',
    pattern: /^\/events\/([^/]+)\/?$/i,
    validate: (req) => {
      parse(schemas.slugParam, req.params, 'event slug');
      assertParamsOnlyDelete(req, 'event delete');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/accounts\/([^/]+)\/override\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'account id');
      return parse(schemas.accountOverride, req.body, 'account override');
    },
  },
  {
    method: 'POST',
    pattern: /^\/manual-assets\/?$/i,
    validate: (req) => parse(schemas.manualAsset, req.body, 'manual asset'),
  },
  {
    method: 'DELETE',
    pattern: /^\/manual-assets\/([^/]+)\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'manual asset id');
      assertParamsOnlyDelete(req, 'manual asset delete');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/recurring\/([^/]+)\/override\/?$/i,
    validate: (req) => parseRecurringOverrideRequest(req),
  },
  {
    method: 'POST',
    pattern: /^\/recurring\/mark\/?$/i,
    validate: (req) => parse(schemas.markRecurring, req.body, 'recurring mark'),
  },
  {
    method: 'POST',
    pattern: /^\/bills\/paid\/?$/i,
    validate: (req) => parse(schemas.markBill, req.body, 'bill state'),
  },
  {
    method: 'POST',
    pattern: /^\/owes-config\/?$/i,
    validate: (req) => parse(schemas.owesConfig, req.body, 'reimbursement configuration'),
  },
  {
    method: 'POST',
    pattern: /^\/reimb-links\/?$/i,
    validate: (req) => parse(schemas.reimbLink, req.body, 'reimbursement link'),
  },
  {
    method: 'DELETE',
    pattern: /^\/reimb-links\/?$/i,
    validate: (req) => {
      if (hasNonEmptyBody(req)) {
        return parse(schemas.deleteReimbLink, req.body, 'reimbursement unlink');
      }
      return parse(schemas.deleteReimbLink, {
        inflowId: req.query.inflowId,
        expenseId: req.query.expenseId,
      }, 'reimbursement unlink');
    },
  },
  {
    method: 'POST',
    pattern: /^\/repayments\/([^/]+)\/confirm\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'repayment id');
      parse(schemas.confirmRepaymentQuery, req.query, 'repayment confirmation query');
      if (hasNonEmptyBody(req)) {
        parse(schemas.confirmRepaymentBody, req.body, 'repayment confirmation body');
      }
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/repayments\/([^/]+)\/dismiss\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'repayment id');
      assertStrictEmptyQuery(req, 'repayment dismissal');
      if (hasNonEmptyBody(req)) {
        parse(schemas.dismissRepaymentBody, req.body, 'repayment dismissal body');
      }
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/reconciliation\/item\/?$/i,
    validate: (req) => parse(schemas.reconcileItem, req.body, 'reconciliation item'),
  },
  {
    method: 'POST',
    pattern: /^\/reconciliation\/month\/?$/i,
    validate: (req) => parse(schemas.reconcileMonth, req.body, 'reconciliation month'),
  },
  {
    method: 'POST',
    pattern: /^\/reconciliation\/enabled\/?$/i,
    validate: (req) => parse(schemas.reconcileEnabled, req.body, 'reconciliation setting'),
  },
  {
    method: 'POST',
    pattern: /^\/goals\/?$/i,
    validate: (req) => parse(schemas.goal, req.body, 'goal'),
  },
  {
    method: 'DELETE',
    pattern: /^\/goals\/([^/]+)\/?$/i,
    validate: (req) => {
      parse(schemas.idParam, req.params, 'goal id');
      assertParamsOnlyDelete(req, 'goal delete');
      return null;
    },
  },
  {
    method: 'POST',
    pattern: /^\/refresh\/?$/i,
    validate: (req) => {
      assertNoPayload(req, 'refresh');
      return null;
    },
  },
];

function findMutationContract(req) {
  const path = normalizeMutationPath(req);
  return MUTATION_CONTRACTS.find(
    (entry) => entry.method === req.method && entry.pattern.test(path),
  ) || null;
}

function validateMutationRequest(req) {
  const contract = findMutationContract(req);
  if (!contract) return null;
  return contract.validate(req);
}

function validateVersionedMutationRequest(req) {
  return validateMutationRequest(req);
}

function validateLegacyMutationRequest(req) {
  return validateMutationRequest(req);
}

const VERSIONED_READ_ROUTE_PATTERNS = [
  /^\/operations\/[^/]+$/i,
  /^\/ping$/i,
  /^\/reconnect-freshness$/i,
  /^\/accounts$/i,
  /^\/today$/i,
  /^\/transactions(?:\/[^/]+)?$/i,
  /^\/spending$/i,
  /^\/trends$/i,
  /^\/budgets$/i,
  /^\/reimbursement$/i,
  /^\/review$/i,
  /^\/reimbursement-ledger$/i,
  /^\/reimbursement-export$/i,
  /^\/insights$/i,
  /^\/merchant-history$/i,
  /^\/categories$/i,
  /^\/recurring$/i,
  /^\/bills$/i,
  /^\/forecast$/i,
  /^\/income$/i,
  /^\/search$/i,
  /^\/goals$/i,
  /^\/tags$/i,
  /^\/rules$/i,
  /^\/manual-assets$/i,
  /^\/investments$/i,
  /^\/reports$/i,
  /^\/receipts(?:\/[^/]+(?:\/image)?)?$/i,
  /^\/events$/i,
  /^\/owes-config$/i,
  /^\/reimb-links$/i,
  /^\/repayments\/suggestions$/i,
  /^\/reconciliation(?:\/pending)?$/i,
  /^\/report\.csv$/i,
  /^\/phantom\/log$/i,
];

function versionedRouteExists(req) {
  const path = req.path || '/';
  return MUTATION_CONTRACTS.some((entry) => entry.pattern.test(path))
    || VERSIONED_READ_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

module.exports = {
  MUTATION_CONTRACTS,
  VERSIONED_READ_ROUTE_PATTERNS,
  assertEmptyBody,
  assertNoPayload,
  assertParamsOnlyDelete,
  assertQueryOnly,
  assertReceiptEncodedWithinLimits,
  findMutationContract,
  normalizeMutationPath,
  parsePhantomCleanupRequest,
  parseReceiptRequest,
  parseRecurringOverrideRequest,
  validateLegacyMutationRequest,
  validateMutationRequest,
  validateVersionedMutationRequest,
  versionedRouteExists,
};
