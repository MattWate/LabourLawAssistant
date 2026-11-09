const assert = require('assert');
const fs = require('fs');
const { normaliseGovernance } = require('../netlify/functions/lib/llmGovernance');

const result = normaliseGovernance({
  primary_track: 'UD-MISCONDUCT',
  confidence: 0.92,
  input_language_detected: 'isiZulu',
  input_language_confidence: 0.97,
  normalized_english_interpretation: 'I was dismissed after a disciplinary hearing.',
  hydrated_facts: {
    employment_status: 'Dismissed',
    dismissal_reason_type: 'Misconduct'
  },
  confidence_per_field: {
    employment_status: 0.95,
    dismissal_reason_type: 0.9
  }
});

assert.strictEqual(result.input_language_detected, 'isiZulu');
assert.strictEqual(result.input_language_confidence, 0.97);
assert.strictEqual(result.normalized_english_interpretation, 'I was dismissed after a disciplinary hearing.');

const web = fs.readFileSync('index.html','utf8');
assert(web.includes('input_language_detected'));
assert(web.includes('normalized_english_interpretation'));
assert(web.includes('original_client_narrative'));

const wa = fs.readFileSync('netlify/functions/lib/whatsappConversation.js','utf8');
assert(wa.includes('input_language_detected'));
assert(wa.includes('normalized_english_interpretation'));
assert(wa.includes('original_client_narrative'));

const ask = fs.readFileSync('netlify/functions/ask.js','utf8');
assert(ask.includes('facts.normalized_english_interpretation ||'));
assert(ask.includes('original_client_narrative: fullStory'));

const drafting = fs.readFileSync('netlify/functions/lib/claudeDrafting.js','utf8');
assert(drafting.includes('facts.normalized_english_interpretation || facts.incident_description'));

const consent = fs.readFileSync('netlify/functions/lib/consentConfig.js','utf8');
assert(consent.includes('English, Afrikaans, isiZulu or isiXhosa'));
assert(consent.includes('all VRS assessments and letters are prepared in English'));

console.log('PASS multilingual intake checks');
