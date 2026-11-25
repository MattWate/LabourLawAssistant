const INTERNAL_LANGUAGE_PATTERNS = [
  /\b(?:high|medium(?:-high)?|low|no)\s+merit\b/i,
  /\bmerit\s+(?:band|score)\b/i,
  /\bwp\s+(?:eligible|posture|type)\b/i,
  /\binternal\s+(?:score|scoring|band|classification)\b/i,
  /\b(system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\bhidden\s+(?:prompt|instructions?)\b/i
];

const OUTCOME_PROMISE_PATTERNS = [
  /\b(?:you|we)\s+(?:will|are going to)\s+(?:win|succeed|get paid|get compensation)\b/i,
  /\bguaranteed\b/i,
  /\bdefinitely\s+(?:win|succeed|entitled)\b/i,
  /\byou\s+have\s+(?:a\s+)?(?:very\s+)?strong\s+case\b/i,
  /\byour\s+dismissal\s+was\s+(?:definitely\s+)?illegal\b/i
];

const DIRECT_ADVICE_PATTERNS = [
  /\byou\s+should\s+(?:resign|accept|reject|settle|sue|sign|refuse)\b/i,
  /\byou\s+must\s+(?:resign|accept|reject|settle|sue|sign|refuse)\b/i,
  /\btake\s+(?:them|your employer)\s+to\s+(?:the\s+)?ccma\b/i
];

const MONEY_PATTERNS = [
  /\bR\s?\d[\d\s,.]*/i,
  /\b\d+(?:[.,]\d+)?\s*(?:rand|months?'?\s+salary|months?'?\s+pay)\b/i
];

const CONTROL_ATTACK_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+(?:instructions?|rules?|messages?)\b/i,
  /\breveal\s+(?:the\s+)?(?:system|developer|hidden)\s+(?:prompt|message|instructions?)\b/i,
  /\bshow\s+me\s+(?:your\s+)?(?:system|developer|hidden)\s+(?:prompt|instructions?)\b/i,
  /\bjailbreak\b/i,
  /\bignoreer\s+(?:alle\s+)?vorige\s+(?:instruksies|re[eë]ls)\b/i,
  /\bwys\s+(?:my\s+)?(?:jou\s+)?(?:stelsel|verborge)\s+(?:prompt|instruksies)\b/i
];

function inspectClientFacingLanguage(text = '') {
  const value = String(text || '').trim();
  if (!value) return { ok: true, issues: [] };

  const issues = [];
  const groups = [
    ['internal_language', INTERNAL_LANGUAGE_PATTERNS],
    ['outcome_promise', OUTCOME_PROMISE_PATTERNS],
    ['direct_legal_advice', DIRECT_ADVICE_PATTERNS],
    ['money_or_settlement_figure', MONEY_PATTERNS]
  ];

  for (const [type, patterns] of groups) {
    if (patterns.some(re => re.test(value))) issues.push(type);
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

function detectConversationControlAttack(text = '') {
  const value = String(text || '');
  return CONTROL_ATTACK_PATTERNS.some(re => re.test(value));
}

function safeClientFacingText(candidate, fallback = null) {
  const value = String(candidate || '').trim();
  if (!value) return { text: fallback, rejected: false, issues: [] };
  const inspection = inspectClientFacingLanguage(value);
  if (inspection.ok) return { text: value, rejected: false, issues: [] };
  return { text: fallback, rejected: true, issues: inspection.issues };
}

module.exports = {
  inspectClientFacingLanguage,
  detectConversationControlAttack,
  safeClientFacingText
};
