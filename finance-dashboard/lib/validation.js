const { z } = require('zod');
const { RequestValidationError } = require('./errors');

const nonEmpty = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 8000) => z.string().max(max).optional().nullable();
const identifier = nonEmpty(200);
const finiteNumber = z.coerce.number().finite();
const money = finiteNumber.refine((value) => Math.abs(value) <= 100_000_000, 'amount is outside the supported range');

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
const nullableIdentifier = identifier.optional().nullable();

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

  budget: z.object({
    month: monthOnly.optional(),
    categoryId: identifier,
    amount: money.refine((value) => value >= 0, 'amount must be non-negative'),
  }).strict(),

  accountOverride: z.object({
    id: identifier.optional(),
    name: z.string().max(300).optional().nullable(),
    hidden: z.boolean().optional(),
  }).strict().refine((value) => value.name !== undefined || value.hidden !== undefined, 'an override field is required'),

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

  receipt: z.object({
    txnId: identifier,
    accountId: identifier,
    transactionDate: dateOnly,
    imageBase64: z.string().min(1).max(34_000_000),
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
    amount: money.refine((value) => value > 0, 'amount must be greater than zero').optional(),
    person: z.string().max(100).optional().nullable(),
  }).strict(),

  deleteReimbLink: z.object({
    inflowId: identifier,
    expenseId: identifier,
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
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  const summary = issues.slice(0, 3).map((issue) => `${issue.path || label}: ${issue.message}`).join('; ');
  throw new RequestValidationError(`Invalid ${label}: ${summary}`, issues);
}

module.exports = {
  dateOnly,
  monthOnly,
  parse,
  schemas,
  validDateOnly,
};
