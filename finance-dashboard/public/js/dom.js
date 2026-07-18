export function accountBadge(name) {
  const n = name.toLowerCase();
  if (n.includes('roth') || n.includes('robinhood') || n.includes('invest')) return ['Investment', 'badge-investment'];
  if (n.includes('credit') || n.includes('unlimited') || n.includes('explorer') || n.includes('freedom')) return ['Credit', 'badge-credit'];
  if (n.includes('saving') || n.includes('apy')) return ['Savings', 'badge-savings'];
  return ['Checking', 'badge-checking'];
}

const TEXT_TONES = ['default', 'green', 'red', 'yellow', 'muted'];

export function applyTextTone(element, tone) {
  if (!element) return;
  for (const name of TEXT_TONES) element.classList.remove(`text-tone-${name}`);
  element.classList.add(`text-tone-${tone}`);
}

export function setHidden(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
}
