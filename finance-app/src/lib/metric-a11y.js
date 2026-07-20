function statCardAccessibilityLabel({ label, value, sub }) {
  if (sub) return `${label}, ${value}, ${sub}`;
  return `${label}, ${value}`;
}

function heroMetricAccessibilityLabel(label, value, sub) {
  const parts = [label, value];
  if (sub) parts.push(sub);
  return parts.join(', ');
}

module.exports = {
  statCardAccessibilityLabel,
  heroMetricAccessibilityLabel,
};
