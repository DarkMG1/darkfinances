/**
 * Picks which multi-action mutation source owns the visible banner outcome and retry.
 * Retry must dispatch only the action that produced the displayed error — never every
 * source that still has retained lastVars from an earlier success.
 */

function pickActiveMutationSource(sources) {
  let active = null;
  for (const source of sources) {
    if (source.outcome) active = source;
  }
  if (!active) {
    return { activeKey: null, outcome: null };
  }
  return {
    activeKey: active.key,
    outcome: active.outcome,
  };
}

function retryActiveMutationSource(sources, activeKey) {
  if (!activeKey) return false;
  const source = sources.find((s) => s.key === activeKey);
  if (!source?.retry) return false;
  source.retry();
  return true;
}

function pickMutationAnnounce(sources) {
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const message = sources[i].announce;
    if (message) return message;
  }
  return '';
}

function anyMutationSourceLocked(sources) {
  return sources.some((s) => s.isLocked);
}

module.exports = {
  anyMutationSourceLocked,
  pickActiveMutationSource,
  pickMutationAnnounce,
  retryActiveMutationSource,
};
