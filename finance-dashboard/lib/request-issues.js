const SENSITIVE_PATH = /base64|secret|token|password|authorization|image/i;

function sanitizeIssuePath(path) {
  const value = String(path || '').trim();
  if (!value || SENSITIVE_PATH.test(value)) return 'body';
  const top = value.split(/[.[\]]/)[0];
  return top || 'request';
}

function sanitizeIssueMessage(issue) {
  if (issue?.code === 'unrecognized_keys') return 'unknown fields are not allowed';
  const message = String(issue?.message || 'invalid value');
  if (/base64|receipt image|image bytes/i.test(message)) return 'invalid receipt image encoding';
  if (/too large|exceeds the maximum/i.test(message)) return 'payload exceeds the maximum allowed size';
  if (/unknown fields are not allowed/i.test(message)) return 'unknown fields are not allowed';
  if (/request body is not allowed|query parameters are not allowed/i.test(message)) return message;
  return message.replace(/^[^:]+:\s*/, '').trim() || 'invalid value';
}

function sanitizeIssues(issues = []) {
  return issues.map((issue) => ({
    path: sanitizeIssuePath(issue.path),
    message: sanitizeIssueMessage(issue),
  }));
}

module.exports = {
  sanitizeIssueMessage,
  sanitizeIssuePath,
  sanitizeIssues,
};
