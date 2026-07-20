/**
 * Optional mutation UI callbacks must not break lock/admission/outcome mapping.
 */

function safeMutationCallback(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch {
    // Swallow user callback throws; core mutation lifecycle continues.
  }
}

module.exports = {
  safeMutationCallback,
};
