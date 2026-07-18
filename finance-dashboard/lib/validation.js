const { z } = require('zod');
const { RequestValidationError } = require('./errors');
const { toCents } = require('./domain/money');
const { sanitizeIssues } = require('./request-issues');
const {
  RECEIPT_MAX_BASE64_CHARS,
  RECEIPT_MAX_DECODED_BYTES,
  exactBase64DecodedBytes,
  isStrictBase64,
  stripBase64Envelope,
} = require('./receipt-limits');

const nonEmpty = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 8000) => z.string().max(max).optional().nullable();
const identifier = nonEmpty(200);
const MAX_MONEY_DOLLARS = 100_000_000;
const MAX_MONEY_CENTS = MAX_MONEY_DOLLARS * 100;
const money = z.number({ invalid_type_error: 'money value must be a JSON number' })
  .finite('money value must be finite')
  .refine((value) => !Object.is(value, -0), 'money value must not be negative zero')
  .refine((value) => Math.abs(value) <= MAX_MONEY_DOLLARS, 'money value is outside the supported range')
  .refine((value) => {
    try {
      toCents(value);
      return true;
    } catch (_) {
      return false;
    }
  }, 'money value must use whole cents');
const nonNegativeCentAmount = z.number({ invalid_type_error: 'cent amount must be a JSON number' })
  .int('cent amount must be an integer')
  .min(0, 'cent amount must be non-negative')
  .max(MAX_MONEY_CENTS, 'cent amount is outside the supported range')
  .refine((value) => !Object.is(value, -0), 'cent amount must not be negative zero');

function validDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, ys, ms, ds] = match;
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const dateOnly = z.string().refine(validDateOnly, 'date must be a real YYYY-MM-DD date');
const monthOnly = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');

const owesTripEntry = z.object({
  event: z.string().max(200).optional(),
  amount: money.refine((value) => value >= 0, 'amount must be non-negative'),
}).strict();

const owesConfig = z.object({
  expected: z.record(z.record(nonNegativeCentAmount)).optional(),
  debtorPatterns: z.record(z.string().max(500)).optional(),
  tripStart: z.record(dateOnly).optional(),
  swNet: z.array(z.string().max(200)).max(1000).optional(),
  settledExt: z.array(z.string().max(200)).max(1000).optional(),
  autoReimbTags: z.array(z.string().max(100)).max(100).optional(),
  eventStatus: z.record(z.string().max(80)).optional(),
  autoDetectExcludeEvents: z.array(z.string().max(200)).max(1000).optional(),
  manualTrips: z.record(z.array(owesTripEntry)).optional(),
}).strict();

const nullableIdentifier = identifier.optional().nullable();
const accountRole = z.enum(['operating_cash', 'protected_savings', 'credit_card', 'loan', 'investment', 'excluded', 'unknown']);

const transactionRef = z.object({
  id: identifier,
  date: dateOnly.optional().nullable(),
  payee: z.string().max(300).optional().default(''),
  amount: money,
  accountId: nullableIdentifier,
  account: z.string().max(300).optional(),
  imported: z.boolean().optional(),
}).strict();

const cancellation = z.object({
  status: z.string().max(80).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  confirmationDate: dateOnly.optional().nullable(),
  refundRequested: z.boolean().optional().nullable(),
  retentionOffer: z.string().max(1000).optional().nullable(),
  watchNextRenewal: z.boolean().optional().nullable(),
}).strict();

const schemas = {
  idParam: z.object({ id: identifier }).strict(),
  keyParam: z.object({ key: identifier }).strict(),
  slugParam: z.object({ slug: nonEmpty(80) }).strict(),

  createTransaction: z.object({
    accountId: identifier,
    amount: money.refine((value) => value !== 0, 'amount must be non-zero'),
    payee: z.string().trim().max(300).optional().default(''),
    date: dateOnly.optional(),
    categoryId: nullableIdentifier,
    notes: optionalText(),
  }).strict(),

  splitTransaction: z.object({
    id: identifier.optional(),
    accountId: identifier,
    date: dateOnly,
    legs: z.array(z.object({
      id: identifier.optional().nullable(),
      amount: money.refine((value) => value !== 0, 'leg amount must be non-zero'),
      categoryId: nullableIdentifier,
      name: z.string().trim().max(300).optional().default(''),
      notes: z.string().max(8000).optional().default(''),
    }).strict()).min(2).max(100),
  }).strict(),

  unsplitTransaction: z.object({
    id: identifier.optional(),
    accountId: identifier,
    date: dateOnly,
    categoryId: nullableIdentifier,
  }).strict(),

  setCategory: z.object({
    id: identifier.optional(),
    categoryId: nullableIdentifier,
    isLeg: z.boolean().optional().default(false),
    parentId: nullableIdentifier,
    accountId: nullableIdentifier,
    date: dateOnly.optional().nullable(),
  }).strict(),

  setNotes: z.object({
    id: identifier.optional(),
    notes: z.string().max(8000).optional().nullable(),
    isLeg: z.boolean().optional().default(false),
    parentId: nullableIdentifier,
    accountId: nullableIdentifier,
    date: dateOnly.optional().nullable(),
  }).strict(),

  setPayee: z.object({
    id: identifier.optional(),
    payee: z.string().trim().max(300),
    isLeg: z.boolean().optional().default(false),
    parentId: nullableIdentifier,
    accountId: nullableIdentifier,
    date: dateOnly.optional().nullable(),
  }).strict(),

  setDate: z.object({
    id: identifier.optional(),
    date: dateOnly,
    isLeg: z.boolean().optional().default(false),
  }).strict(),

  deleteTransactionQuery: z.object({
    accountId: identifier,
    date: dateOnly,
  }).strict(),

  deleteTransactionBody: z.object({
    id: identifier.optional(),
    accountId: identifier.optional(),
    date: dateOnly.optional(),
  }).strict(),

  confirmRepaymentQuery: z.object({
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  }).strict(),

  confirmRepaymentBody: z.object({
    id: identifier.optional(),
  }).strict(),

  dismissRepaymentBody: z.object({
    id: identifier.optional(),
    inflowId: identifier.optional(),
  }).strict(),

  budget: z.object({
    month: monthOnly.optional(),
    categoryId: identifier,
    amount: money.refine((value) => value >= 0, 'amount must be non-negative'),
  }).strict(),

  accountOverride: z.object({
    id: identifier.optional(),
    name: z.string().max(300).optional().nullable(),
    hidden: z.boolean().optional(),
    role: accountRole.optional().nullable(),
    creditLiabilityCoverage: z.enum(['exclude', 'current_balance', 'statement']).optional().nullable(),
    paymentRecurringKey: z.string().max(200).optional().nullable(),
    fundingAccountId: identifier.optional().nullable(),
    statement: z.object({
      balanceCents: z.number().int(),
      paymentDueDate: dateOnly,
      observedAt: z.string().datetime(),
    }).strict().optional().nullable(),
    clearCreditLiability: z.boolean().optional(),
  }).strict().refine(
    (value) => value.name !== undefined
      || value.hidden !== undefined
      || value.role !== undefined
      || value.creditLiabilityCoverage !== undefined
      || value.paymentRecurringKey !== undefined
      || value.fundingAccountId !== undefined
      || value.statement !== undefined
      || value.clearCreditLiability === true,
    'an override field is required',
  ),

  reviewDisposition: z.object({
    id: nonEmpty(500),
    disposition: z.enum(['acknowledge', 'snooze', 'dismiss', 'resolved', 'clear']),
    until: z.string().datetime().optional().nullable(),
    note: z.string().max(1000).optional().nullable(),
  }).strict().refine((value) => value.disposition !== 'snooze' || !!value.until, 'snooze requires an until timestamp'),

  manualAsset: z.object({
    id: identifier.optional(),
    name: nonEmpty(300),
    value: money.refine((value) => value > 0, 'value must be greater than zero'),
    kind: z.enum(['asset', 'liability']),
  }).strict(),

  goal: z.object({
    id: identifier.optional(),
    name: nonEmpty(300),
    target: money.refine((value) => value > 0, 'target must be greater than zero'),
    accountId: nullableIdentifier,
    deadline: monthOnly.optional().nullable(),
    current: money.refine((value) => value >= 0, 'current must be non-negative').optional(),
  }).strict(),

  rule: z.object({
    match: nonEmpty(300),
    categoryId: identifier,
    categoryName: z.string().max(300).optional().default(''),
  }).strict(),

  event: z.object({
    slug: z.string().max(80).optional(),
    name: nonEmpty(300),
    start: dateOnly.optional(),
    members: z.union([z.array(z.string().max(100)).max(100), z.string().max(5000)]).optional(),
    group: z.string().max(300).optional().nullable(),
  }).strict(),

  recurringOverride: z.object({
    key: identifier.optional(),
    status: z.enum(['active', 'inactive', 'cancelled']).optional().nullable(),
    hidden: z.boolean().optional(),
    forced: z.boolean().optional(),
    isBill: z.boolean().optional().nullable(),
    categoryId: identifier.optional().nullable(),
    cancellation: cancellation.optional(),
  }).strict(),

  markRecurring: z.object({
    payee: nonEmpty(300),
    isBill: z.boolean().optional(),
  }).strict(),

  markBill: z.object({
    id: identifier.optional(),
    key: identifier.optional(),
    dueDate: dateOnly.optional(),
    paid: z.boolean(),
  }).strict().refine((value) => Boolean(value.id || (value.key && value.dueDate)), 'bill id or key and dueDate are required'),

  owesConfig,

  receipt: z.object({
    txnId: identifier,
    accountId: identifier,
    transactionDate: dateOnly,
    imageBase64: z.string().min(1, 'imageBase64 is required').transform(stripBase64Envelope).pipe(
      z.string().max(RECEIPT_MAX_BASE64_CHARS).superRefine((encoded, ctx) => {
        if (!isStrictBase64(encoded)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid receipt image encoding' });
          return;
        }
        const decoded = exactBase64DecodedBytes(encoded);
        if (decoded > RECEIPT_MAX_DECODED_BYTES) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'payload exceeds the maximum allowed size' });
        }
      }),
    ),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
    ocrText: z.string().max(8000).optional(),
    ocrLines: z.array(z.string().max(1000)).max(200).optional(),
    amount: money.optional().nullable(),
    date: dateOnly.optional().nullable(),
    source: z.enum(['camera', 'library']).optional(),
  }).strict(),

  reimbLink: z.object({
    inflow: transactionRef,
    expense: transactionRef,
    allocationCents: nonNegativeCentAmount.refine((value) => value > 0, 'allocationCents must be greater than zero').optional(),
    amount: money.refine((value) => value > 0, 'amount must be greater than zero').optional(),
    person: z.string().max(100).optional().nullable(),
    expectedVersion: z.number().int().min(0).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.allocationCents == null && value.amount == null) {
      ctx.addIssue({ code: 'custom', message: 'allocationCents or amount is required' });
      return;
    }
    if (value.allocationCents != null && value.amount != null) {
      const fromAmount = Math.round(Math.abs(Number(value.amount) * 100));
      if (fromAmount !== value.allocationCents) {
        ctx.addIssue({ code: 'custom', message: 'allocationCents and amount must agree when both are provided' });
      }
    }
  }),

  deleteReimbLink: z.object({
    inflowId: identifier,
    expenseId: identifier,
    expectedVersion: z.number().int().min(0).optional(),
  }).strict(),

  reimbursementSweep: z.object({
    tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  }).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from must not be after to'),

  phantomCleanupQuery: z.object({
    dryRun: z.enum(['1', 'true', '0', 'false']).optional(),
    window: z.coerce.number().int().min(1).max(365).optional(),
    agedDays: z.coerce.number().int().min(1).max(365).optional(),
    observeDays: z.coerce.number().int().min(0).max(365).optional(),
    holdAgedDays: z.coerce.number().int().min(1).max(365).optional(),
    holdObserveDays: z.coerce.number().int().min(0).max(365).optional(),
  }).strict(),

  reconcileItem: z.object({
    month: monthOnly,
    id: identifier,
    reconciled: z.boolean(),
  }).strict(),

  reconcileMonth: z.object({
    month: monthOnly,
    done: z.boolean(),
  }).strict(),

  reconcileEnabled: z.object({
    enabled: z.boolean(),
  }).strict(),
};

function parse(schema, value, label = 'request') {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issues = sanitizeIssues(result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  })));
  const summary = issues.slice(0, 3).map((issue) => {
    if (/unknown fields are not allowed/i.test(issue.message)) return `${label}: unknown fields are not allowed`;
    return `${issue.path || label}: ${issue.message}`;
  }).join('; ');
  throw new RequestValidationError(`Invalid ${label}: ${summary}`, issues);
}

module.exports = {
  dateOnly,
  monthOnly,
  parse,
  schemas,
  validDateOnly,
};
