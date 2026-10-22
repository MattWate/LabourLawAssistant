const ANTHROPIC_VERSION = '2023-06-01';

// Production model is deliberately pinned. Change CLAUDE_MODEL only through the
// governed model-change process and test the replacement on staging first.
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

function getClaudeModel() {
  return String(process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL).trim();
}

function anthropicHeaders() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  return {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': ANTHROPIC_VERSION
  };
}

function modelAuditMetadata() {
  return {
    provider: 'anthropic',
    model: getClaudeModel(),
    model_source: process.env.CLAUDE_MODEL ? 'environment' : 'pinned_default',
    anthropic_version: ANTHROPIC_VERSION
  };
}

module.exports = {
  ANTHROPIC_VERSION,
  DEFAULT_CLAUDE_MODEL,
  getClaudeModel,
  anthropicHeaders,
  modelAuditMetadata
};
