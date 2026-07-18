const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('mutation form components expose accessibility live region and 44pt targets', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/mutation-form.tsx'), 'utf8');
  assert.match(source, /accessibilityLiveRegion/);
  assert.match(source, /minHeight: 44/);
  assert.match(source, /accessibilityRole="alert"/);
});

test('profile purge clears mutation form drafts', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/profile-purge.ts'), 'utf8');
  assert.match(source, /purgeMutationFormDrafts/);
});

test('requests propagate validation issues on finance errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/api/client/requests.ts'), 'utf8');
  assert.match(source, /issues\?: ValidationIssue\[\]/);
  assert.match(source, /requiresIdempotencyKeyReuse/);
});

test('add transaction screen uses mutation form banner not alert errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/add-transaction.tsx'), 'utf8');
  assert.match(source, /useMutationForm/);
  assert.match(source, /MutationFormBanner/);
  assert.doesNotMatch(source, /Alert\.alert\('Could not add'/);
});

test('mutation hooks clear retry variables after success', () => {
  const form = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  const action = fs.readFileSync(path.join(root, 'src/hooks/useMutationAction.ts'), 'utf8');
  const screen = fs.readFileSync(path.join(root, 'src/hooks/useMutationScreen.ts'), 'utf8');
  assert.match(form, /variablesRef\.current = null/);
  assert.match(action, /lastVars\.current = null/);
  assert.match(screen, /entry\.lastVars = null/);
});

test('mutation hooks unlock on settled and guard stale profile callbacks', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(root, 'src/hooks', rel), 'utf8');
    assert.match(source, /onSettled/, `${rel} must unlock in onSettled`);
    assert.match(source, /useMutationHookIdentity/, `${rel} must use shared identity hook`);
    assert.match(source, /isDispatchTokenCurrent\(token\)/, `${rel} must guard callbacks with dispatch token`);
  }
  const screen = fs.readFileSync(path.join(root, 'src/hooks/useMutationScreen.ts'), 'utf8');
  assert.match(screen, /onSettled:\s*\(\)\s*=>\s*\{[\s\S]*releaseAdmissionFromSettle\(\)/);
  assert.match(screen, /onSettled:\s*\(\)\s*=>\s*\{[\s\S]*if \(!isDispatchTokenCurrent\(token\)\) return;/);
  assert.match(screen, /onSettled:\s*\(\)\s*=>\s*\{[\s\S]*releaseAdmissionFromSettle\(\);[\s\S]*if \(!isDispatchTokenCurrent\(token\)\) return;[\s\S]*markPending\(key, false\)/);
  assert.match(screen, /setPendingKeys\(new Set\(\)\)/);
  assert.match(screen, /isPending: pendingKeys\.has/);
});

test('goals sheet blocks dismiss while locked and uses combined coordinator lock', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/goals.tsx'), 'utf8');
  assert.match(source, /canDismiss={form\.canDismiss/);
  assert.match(source, /banner\.isLocked/);
  assert.match(source, /requestDismiss/);
  assert.match(source, /admissionRef/);
  assert.equal((source.match(/<MutationLiveRegion/g) || []).length, 1);
});

test('mutation forms confirm discard when dirty', () => {
  const form = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(form, /Discard unsaved changes\?/);
  assert.match(form, /isDirty/);
});

test('add transaction and split editor block hardware back while submitting', () => {
  for (const rel of ['add-transaction.tsx', 'split/[id].tsx']) {
    const source = fs.readFileSync(path.join(root, 'src/app', rel), 'utf8');
    assert.match(source, /beforeRemove/, `${rel} must guard navigation during submit`);
    assert.match(source, /preventDefault/, `${rel} must prevent back while locked`);
  }
});

test('transaction detail blocks route back while mutation screen locked and confirms dirty notes discard', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/transaction/[id].tsx'), 'utf8');
  assert.match(source, /beforeRemove/);
  assert.match(source, /screen\.isLocked|modalLocked/);
  assert.match(source, /requestLeave/);
  assert.match(source, /Discard unsaved changes\?/);
  assert.match(source, /allowBackRef/);
});

test('split editor confirms dirty discard on cancel and hardware back', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/split/[id].tsx'), 'utf8');
  assert.match(source, /requestSplitExit/);
  assert.match(source, /beforeRemove/);
  assert.match(source, /allowExitRef/);
  assert.match(source, /isSplitEditorDirty/);
  assert.match(source, /seedSplitEditorBaseline/);
});

test('client validation haptic is owned by mutation outcome gate', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/haptics.ts'), 'utf8');
  const fn = source.match(/export function hapticClientValidationRejected\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /mutationOutcomeHaptics\.emitClientValidationError/);
  assert.doesNotMatch(fn, /haptics\.warning\(\)/);
  const screen = fs.readFileSync(path.join(root, 'src/hooks/useMutationScreen.ts'), 'utf8');
  assert.match(screen, /hapticClientValidationRejected\(\)/);
});

test('transaction link allocation surfaces inline field errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/transaction/[id].tsx'), 'utf8');
  assert.match(source, /allocationFieldError/);
  assert.match(source, /transaction-link-allocation-error/);
  assert.match(source, /fieldOrder: \['allocationCents'\]/);
});

test('budgets maps server amount validation to targetText with focus path', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/budgets.tsx'), 'utf8');
  assert.match(source, /FORM_SCREEN_PATH_OVERRIDES\.budgets/);
  assert.match(source, /fieldOrder: \['targetText'\]/);
  assert.match(source, /form\.getFieldError\('targetText'\)/);
  assert.match(source, /budgets-target-error/);
});

test('mutation hooks expose synchronous pending guards for UI lock', () => {
  const form = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  const action = fs.readFileSync(path.join(root, 'src/hooks/useMutationAction.ts'), 'utf8');
  assert.match(form, /dispatchPending/);
  assert.match(action, /dispatchPending/);
  assert.match(form, /pendingLockRef/);
  assert.match(action, /pendingLockRef/);
});

test('transaction receipt viewer guards open/close/delete with modal lock and deleting state', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/transaction/[id].tsx'), 'utf8');
  assert.match(source, /removeReceipt/);
  assert.match(source, /receiptViewerLocked = modalLocked \|\| receiptDeleting/);
  assert.match(source, /openReceiptViewer/);
  assert.match(source, /closeReceiptViewer/);
  assert.match(source, /receiptDeleting/);
  assert.match(source, /modalLocked \|\| unlinkAction\.isPending/);
});

test('networth manual sheet uses stable session formId and dirty kind changes', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/networth.tsx'), 'utf8');
  assert.match(source, /manualSessionId/);
  assert.match(source, /manual-new-\$\{manualSessionId\}/);
  assert.doesNotMatch(source, /manual-new-\$\{edit\.kind\}/);
  assert.match(source, /form\.requestDismiss/);
});

test('sheet mutation forms confirm dirty dismiss on close', () => {
  for (const rel of ['goals.tsx', 'budgets.tsx', 'account/[id].tsx', 'networth.tsx']) {
    const source = fs.readFileSync(path.join(root, 'src/app', rel), 'utf8');
    assert.match(source, /useMutationForm/, `${rel} uses mutation form`);
    assert.match(source, /requestDismiss/, `${rel} confirms dirty dismiss`);
  }
  const addTxn = fs.readFileSync(path.join(root, 'src/app/add-transaction.tsx'), 'utf8');
  assert.match(addTxn, /useMutationForm/);
  assert.match(addTxn, /requestDismiss/);
});

test('inline mutation forms use stable formId and wired setFields where drafts apply', () => {
  for (const rel of ['rules.tsx', 'events.tsx']) {
    const source = fs.readFileSync(path.join(root, 'src/app', rel), 'utf8');
    assert.match(source, /useMutationForm/, `${rel} uses mutation form`);
    assert.doesNotMatch(source, /setFields:\s*\(\)\s*=>\s*\{\}/, `${rel} must not noop setFields`);
  }
});

test('mutation hooks capture per-dispatch ids in dispatch tokens', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts', 'useMutationHookIdentity.ts']) {
    const source = fs.readFileSync(path.join(root, 'src/hooks', rel), 'utf8');
    assert.match(source, /captureDispatchToken|captureMutationDispatchToken/, `${rel} captures dispatch token`);
    assert.match(source, /isDispatchTokenCurrent|isMutationDispatchTokenCurrent/, `${rel} validates dispatch token`);
  }
  const identity = fs.readFileSync(path.join(root, 'src/lib/mutation-hook-identity.js'), 'utf8');
  assert.match(identity, /dispatchId/);
});

test('multi-action screens pass activitySeq into banner coordinator', () => {
  for (const rel of ['goals.tsx', 'events.tsx', 'rules.tsx', 'reconcile.tsx', 'split/[id].tsx', 'reimbursement.tsx']) {
    const source = fs.readFileSync(path.join(root, 'src/app', rel), 'utf8');
    assert.match(source, /activitySeq:/, `${rel} must pass activitySeq to coordinator`);
  }
});
