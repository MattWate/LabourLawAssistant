const crypto = require('crypto');

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function flattenDraft(draft = {}) {
  const s = draft?.part_a_letter || draft || {};
  const out = [];
  if (Array.isArray(s.opening_paragraphs)) out.push(...s.opening_paragraphs);
  if (Array.isArray(s.legal_claims)) {
    for (const claim of s.legal_claims) out.push(claim?.title || '', claim?.text || '');
  }
  if (s.settlement_intro) out.push(s.settlement_intro);
  if (Array.isArray(s.settlement_terms)) out.push(...s.settlement_terms);
  if (Array.isArray(s.conclusion_paragraphs)) out.push(...s.conclusion_paragraphs);
  if (!out.length && typeof draft === 'string') out.push(draft);
  return out.filter(Boolean).join('\n');
}

function tokens(text = '') {
  return new Set(
    String(text || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(x => x.length >= 4)
  );
}

function jaccard(a = '', b = '') {
  const aa = tokens(a), bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const item of aa) if (bb.has(item)) intersection += 1;
  return intersection / (aa.size + bb.size - intersection);
}

function extractDates(text = '') {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/gi,
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/gi
  ];
  const found = [];
  for (const re of patterns) found.push(...(String(text || '').match(re) || []));
  return [...new Set(found.map(x => x.toLowerCase()))];
}

function extractRandAmounts(text = '') {
  return [...new Set((String(text || '').match(/\bR\s?\d[\d\s,.]*/g) || []).map(x => x.replace(/\s+/g, '').toLowerCase()))];
}

function isBroadRewriteRequest(request = '') {
  return /\b(rewrite|redraft|rework|restructure|replace|whole letter|entire letter|substantially revise|start again)\b/i.test(String(request || ''));
}

function validateRevisionIntegrity({ caseBrief = {}, draft = {} } = {}) {
  const round = Number(caseBrief.revision_round || 0);
  if (!round) return { ok: true, defects: [], metrics: { revision: false } };

  const source = String(caseBrief.revision_source_letter || '');
  const request = String(caseBrief.client_requested_changes || '');
  const revised = flattenDraft(draft);
  const defects = [];

  if (!source.trim()) defects.push('Revision integrity failure: the exact source letter is missing.');
  if (!request.trim()) defects.push('Revision integrity failure: the client change request is missing.');
  if (!revised.trim()) defects.push('Revision integrity failure: the revised draft is empty.');

  const similarity = source && revised ? jaccard(source, revised) : 0;
  if (source && revised && !isBroadRewriteRequest(request) && similarity < 0.28) {
    defects.push('Targeted revision changed too much unaffected content. Preserve the prior draft except where the client request or mandatory legal/quality corrections require a change.');
  }

  const allowedCorpus = [source, request, JSON.stringify(caseBrief.structured_case_facts || {}), caseBrief.original_client_narrative || '', caseBrief.incident_description || ''].join('\n').toLowerCase();
  for (const date of extractDates(revised)) {
    if (!allowedCorpus.includes(date)) defects.push(`Revision introduced an unverified date: ${date}.`);
  }
  for (const amount of extractRandAmounts(revised)) {
    if (!allowedCorpus.replace(/\s+/g, '').includes(amount)) defects.push(`Revision introduced an unverified rand amount: ${amount.toUpperCase()}.`);
  }

  const suppliedHash = String(caseBrief.revision_source_hash || '').trim();
  if (suppliedHash && source && suppliedHash !== sha256(source)) {
    defects.push('Revision integrity failure: the stored revision source hash does not match the source letter.');
  }

  return {
    ok: defects.length === 0,
    defects: [...new Set(defects)],
    metrics: {
      revision: true,
      revision_round: round,
      source_hash: source ? sha256(source) : null,
      similarity: Number(similarity.toFixed(3)),
      broad_rewrite_requested: isBroadRewriteRequest(request)
    }
  };
}

module.exports = { flattenDraft, validateRevisionIntegrity, sha256 };
