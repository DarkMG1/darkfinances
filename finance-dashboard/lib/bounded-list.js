'use strict';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_LIST_OFFSET = 1_000_000;
const MAX_OCR_LIST_LIMIT = 10;

function boundedString(value, maxLength) {
  return String(value ?? '').slice(0, maxLength);
}

function normalizeBoundedListOptions({
  limit,
  offset,
} = {}, {
  defaultLimit = DEFAULT_LIST_LIMIT,
  maxLimit = MAX_LIST_LIMIT,
  maxOffset = MAX_LIST_OFFSET,
} = {}) {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  const effectiveLimit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, maxLimit)
    : defaultLimit;
  const effectiveOffset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0
    ? Math.min(parsedOffset, maxOffset)
    : 0;
  return { limit: effectiveLimit, offset: effectiveOffset };
}

function paginateBoundedList(items, options, limits) {
  const source = Array.isArray(items) ? items : [];
  const { limit, offset } = normalizeBoundedListOptions(options, limits);
  const end = Math.min(source.length, offset + limit);
  const complete = end >= source.length;
  return {
    items: source.slice(offset, end),
    truncated: !complete,
    pagination: {
      limit,
      offset,
      nextOffset: complete ? null : end,
      complete,
      total: source.length,
    },
  };
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_LIST_OFFSET,
  MAX_OCR_LIST_LIMIT,
  boundedString,
  normalizeBoundedListOptions,
  paginateBoundedList,
};
