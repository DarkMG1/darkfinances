'use strict';

const HIDDEN_SPEND_ID = '00000000-0000-4000-8000-000000000010';
const EXCLUDED_ID = '00000000-0000-4000-8000-000000000011';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000012';
const OPERATING_ID = '00000000-0000-4000-8000-000000000013';
const PROTECTED_ID = '00000000-0000-4000-8000-000000000014';
const CREDIT_ID = '00000000-0000-4000-8000-000000000015';
const SPLITWISE_ID = '00000000-0000-4000-8000-000000000099';
const CLOSED_ID = '00000000-0000-4000-8000-000000000016';

module.exports = {
  HIDDEN_SPEND_ID,
  EXCLUDED_ID,
  UNKNOWN_ID,
  OPERATING_ID,
  PROTECTED_ID,
  CREDIT_ID,
  SPLITWISE_ID,
  CLOSED_ID,
  matrixAccounts: [
    { id: OPERATING_ID, name: 'Checking', closed: false, offbudget: false, balance: 100000, role: 'operating_cash' },
    { id: PROTECTED_ID, name: 'Savings', closed: false, offbudget: false, balance: 200000, role: 'protected_savings' },
    { id: CREDIT_ID, name: 'Card', closed: false, offbudget: false, balance: -5000, role: 'credit_card' },
    { id: HIDDEN_SPEND_ID, name: 'Old Card', closed: false, offbudget: false, balance: -20000, role: 'credit_card' },
    { id: EXCLUDED_ID, name: 'External', closed: false, offbudget: false, balance: 5000000, role: 'excluded' },
    { id: UNKNOWN_ID, name: 'Mystery', closed: false, offbudget: false, balance: 10000, role: 'unknown' },
    { id: CLOSED_ID, name: 'Closed', closed: true, offbudget: false, balance: 30000, role: 'operating_cash' },
    { id: SPLITWISE_ID, name: 'Splitwise Ledger', closed: false, offbudget: false, balance: -1500, role: 'operating_cash' },
  ],
  overrides: {
    [HIDDEN_SPEND_ID]: { hidden: true, role: 'credit_card' },
    [EXCLUDED_ID]: { role: 'excluded' },
    [OPERATING_ID]: { name: 'Everyday' },
  },
  splitwiseMirrorAccountId: SPLITWISE_ID,
};
