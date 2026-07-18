export function requireChart() {
  const Chart = globalThis.Chart;
  if (typeof Chart !== 'function') {
    throw new Error('Chart.js vendor bundle failed to load');
  }
  return Chart;
}
