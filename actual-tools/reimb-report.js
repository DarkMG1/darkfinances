#!/usr/bin/env node
// Deterministic read-only reimbursement report using the same engine as the API.
// Deployment-specific people, aliases, cutoffs and event states remain in the
// dashboard's gitignored JSON/env configuration.

if (!process.env.ACTUAL_DATA_DIR && process.env.FIX_DATA_DIR) {
  process.env.ACTUAL_DATA_DIR = process.env.FIX_DATA_DIR;
}
const data = require('../finance-dashboard/dataModule');

const money = (value) => `$${Math.abs(Number(value) || 0).toFixed(2)}`;
const signedMoney = (value) => `${Number(value) < 0 ? '-' : ''}${money(value)}`;

(async () => {
  const from = process.env.REIMB_FROM;
  const to = process.env.REIMB_TO;
  const openOnly = process.env.REIMB_OPEN_ONLY === '1';
  const report = await data.getReimbursement({ from, to, openOnly });

  console.log(`REIMBURSEMENT REPORT — ${report.range?.from || from || 'all'} through ${report.range?.to || to || 'today'}`);
  console.log(`Outstanding: ${money(report.totalOwed)} across ${report.debtorCount || 0} people`);
  console.log(`Source: ${report.owesSource || 'ledger'}${report.owesGeneratedAt ? ` at ${report.owesGeneratedAt}` : ''}`);
  if (report.owesWarning) console.log(`Warning: ${report.owesWarning}`);
  console.log('');

  for (const person of report.owes || []) {
    console.log(`${person.slug}: ${money(person.owed)}`);
    for (const trip of person.trips || []) console.log(`  event ${trip.event}: ${money(trip.remaining)}`);
    if (person.misc > 0.005) console.log(`  direct/misc: ${money(person.misc)}`);
  }
  if (!(report.owes || []).length) console.log('All tracked reimbursements are settled.');

  if ((report.events || []).length) {
    console.log('\nEVENTS');
    for (const event of report.events) {
      console.log(`  ${event.event}: ${event.status} · net ${signedMoney(event.net)} · ${event.n} item(s)`);
    }
  }
  await data.api.shutdown();
})().catch(async (error) => {
  console.error('ERR', error?.stack || error);
  try { await data.api.shutdown(); } catch (_) {}
  process.exit(1);
});
