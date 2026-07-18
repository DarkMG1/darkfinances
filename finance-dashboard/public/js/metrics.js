import { fmtPos } from './format.js';

export function renderMetricPos(metric, fallback = 'Unavailable') {
  if (metric?.complete === true && Number.isFinite(metric.value)) return fmtPos(metric.value);
  if (
    metric?.complete === false
    && metric?.lowerBound != null
    && Number.isFinite(metric.lowerBound)
    && metric.lowerBound > 0
  ) {
    return `${metric.lowerBoundLabel || 'at least'} ${fmtPos(metric.lowerBound)}`;
  }
  return fallback;
}
