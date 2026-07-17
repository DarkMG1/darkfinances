#!/usr/bin/env node
// Cent-conserving reimbursement allocation export (shared engine with dashboard API).

if (!process.env.ACTUAL_DATA_DIR && process.env.FIX_DATA_DIR) {
  process.env.ACTUAL_DATA_DIR = process.env.FIX_DATA_DIR;
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const data = require('../finance-dashboard/dataModule');
const {
  exportExitCode,
  formatReimbursementExportCsv,
  formatReimbursementExportHuman,
  stableStringify,
} = require('../finance-dashboard/lib/reimbursement-export-ledger');

function parseArgs(argv) {
  const opts = {
    from: process.env.REIMB_FROM || null,
    to: process.env.REIMB_TO || null,
    strict: process.env.REIMB_STRICT === '1',
    format: process.env.REIMB_FORMAT || 'human',
    output: process.env.REIMB_OUTPUT || null,
    json: false,
    csv: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--json') { opts.format = 'json'; opts.json = true; }
    else if (arg === '--csv') { opts.format = 'csv'; opts.csv = true; }
    else if (arg === '--from') { opts.from = argv[++i] || null; }
    else if (arg === '--to') { opts.to = argv[++i] || null; }
    else if (arg === '--output' || arg === '-o') { opts.output = argv[++i] || null; }
    else if (arg.startsWith('--from=')) opts.from = arg.slice(7) || null;
    else if (arg.startsWith('--to=')) opts.to = arg.slice(5) || null;
    else if (arg.startsWith('--output=')) opts.output = arg.slice(9) || null;
    else if (arg.startsWith('--format=')) opts.format = arg.slice(9) || 'human';
  }
  return opts;
}

function usage() {
  console.log(`Usage: reimb-report.js [options]

Options:
  --from YYYY-MM-DD     Window start (optional)
  --to YYYY-MM-DD       Window end (optional)
  --format human|json|csv
  --output, -o PATH     Write atomically to PATH (no partial artifact on failure)
  --strict              Exit 1 before publishing incomplete/ambiguous exports
  --json                Shorthand for --format=json
  --csv                 Shorthand for --format=csv

Exit codes: 0 complete, 2 incomplete/ambiguous, 1 operational failure
Env: REIMB_FROM, REIMB_TO, REIMB_STRICT, REIMB_FORMAT, REIMB_OUTPUT`);
}

function renderPayload(payload, format) {
  if (format === 'json') return `${stableStringify(payload)}\n`;
  if (format === 'csv') return formatReimbursementExportCsv(payload);
  return formatReimbursementExportHuman(payload);
}

function writeAtomic(targetPath, contents) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, targetPath);
}

(async () => {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const payload = await data.buildReimbursementExport({
    from: opts.from,
    to: opts.to,
    strict: opts.strict,
  });
  const body = renderPayload(payload, opts.format);
  const code = exportExitCode(payload);

  if (opts.output) {
    writeAtomic(path.resolve(opts.output), body);
  } else {
    process.stdout.write(body);
  }

  await data.shutdownApi();
  process.exit(code);
})().catch(async (error) => {
  console.error('ERR', error?.stack || error);
  try {
    await data.shutdownApi();
  } catch (_) {}
  process.exit(1);
});
