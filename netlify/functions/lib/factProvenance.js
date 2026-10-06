const INFERENCE_SOURCES = new Set([
  'claude_inference',
  'initial_narrative_ai',
  'progressive_ai'
]);

const CLIENT_SOURCES = new Set([
  'user_answer',
  'client_answer',
  'client_confirmed',
  'web_answer',
  'whatsapp_answer'
]);

function hasValue(value) {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function isInferenceMetadata(meta = {}) {
  return INFERENCE_SOURCES.has(String(meta.source || '').trim());
}

function isConfirmedForDecision(meta) {
  // Backwards compatibility: historic facts without provenance metadata remain
  // valid. Only facts explicitly marked as unconfirmed inference are excluded.
  if (!meta) return true;
  if (meta.confirmed === true) return true;
  if (meta.confirmed === false) return false;
  if (CLIENT_SOURCES.has(String(meta.source || '').trim())) return true;
  if (isInferenceMetadata(meta)) return false;
  return true;
}

function setFactMetadata(facts = {}, key, metadata = {}) {
  if (!key) return facts;
  return {
    ...facts,
    _fact_metadata: {
      ...(facts._fact_metadata || {}),
      [key]: {
        ...(facts._fact_metadata?.[key] || {}),
        ...metadata,
        captured_at: metadata.captured_at || new Date().toISOString()
      }
    }
  };
}

function markClientConfirmedFact(facts = {}, key, options = {}) {
  return setFactMetadata(facts, key, {
    source: options.source || 'client_confirmed',
    confidence: 1,
    confirmed: true,
    source_turn: options.source_turn ?? null
  });
}

function markClaudeInference(facts = {}, key, options = {}) {
  return setFactMetadata(facts, key, {
    source: options.source || 'claude_inference',
    confidence: Number(options.confidence || 0),
    confirmed: false,
    source_turn: options.source_turn ?? null
  });
}

function factsForDeterministicDecision(facts = {}) {
  const metadata = facts._fact_metadata || {};
  const filtered = { ...facts };

  Object.keys(metadata).forEach(key => {
    if (!isConfirmedForDecision(metadata[key])) {
      delete filtered[key];
    }
  });

  // Preserve provenance for audit/debugging; the scorer ignores this field.
  filtered._fact_metadata = metadata;
  return filtered;
}

function buildFactTrace(facts = {}) {
  const metadata = facts._fact_metadata || {};
  return Object.entries(facts)
    .filter(([key, value]) => !key.startsWith('_') && hasValue(value))
    .map(([key, value]) => ({
      key,
      value,
      source: metadata[key]?.source || 'legacy_or_direct',
      confirmed: isConfirmedForDecision(metadata[key]),
      confidence: metadata[key]?.confidence ?? null,
      source_turn: metadata[key]?.source_turn ?? null,
      captured_at: metadata[key]?.captured_at ?? null
    }));
}

module.exports = {
  hasValue,
  isInferenceMetadata,
  isConfirmedForDecision,
  setFactMetadata,
  markClientConfirmedFact,
  markClaudeInference,
  factsForDeterministicDecision,
  buildFactTrace
};
