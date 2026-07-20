/**
 * Picks which multi-action mutation source owns the visible banner outcome and retry.
 * Latest activation (monotonic activitySeq) is authoritative: when the newest source
 * cleared its outcome after success, older sibling errors must not resurface.
 */

function pickActiveMutationSource(sources) {
  if (!sources.length) {
    return { activeKey: null, outcome: null };
  }
  const maxSeq = Math.max(0, ...sources.map((s) => s.activitySeq ?? 0));
  if (maxSeq === 0) {
    let active = null;
    for (const source of sources) {
      if (source.outcome) active = source;
    }
    if (!active) return { activeKey: null, outcome: null };
    return { activeKey: active.key, outcome: active.outcome };
  }
  const latestSources = sources.filter((s) => (s.activitySeq ?? 0) === maxSeq);
  const latest = latestSources[latestSources.length - 1];
  if (latest?.outcome) {
    return { activeKey: latest.key, outcome: latest.outcome };
  }
  return { activeKey: null, outcome: null };
}

function retryActiveMutationSource(sources, activeKey) {
  if (!activeKey) return false;
  const source = sources.find((s) => s.key === activeKey);
  if (!source?.retry) return false;
  source.retry();
  return true;
}

function pickMutationAnnounce(sources) {
  const maxSeq = Math.max(0, ...sources.map((s) => s.activitySeq ?? 0));
  if (maxSeq === 0) {
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const message = sources[i].announce;
      if (message) return message;
    }
    return '';
  }
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const source = sources[i];
    if ((source.activitySeq ?? 0) !== maxSeq) continue;
    if (source.announce) return source.announce;
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
