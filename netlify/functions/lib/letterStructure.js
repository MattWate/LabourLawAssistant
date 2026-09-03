function safeText(value, fallback = '') {
  return String(value ?? fallback).replace(/\r\n/g, '\n').trim();
}

const DUPLICATE_CLOSING_PATTERNS = [
  /^it is trusted that you will find same to be in order\.?$/i,
  /^yours faithfully[,]?$/i,
  /^yours sincerely[,]?$/i,
  /^kind regards[,]?$/i,
  /^van rensburg schoon$/i,
  /^sasha[- ]lee van wyk$/i,
  /^not signed due to electronic submission$/i
];

function isDuplicateClosingLine(value = '') {
  const text = safeText(value);
  return DUPLICATE_CLOSING_PATTERNS.some(pattern => pattern.test(text));
}

function cleanBodyText(value = '') {
  return safeText(value)
    .split('\n')
    .filter(line => !isDuplicateClosingLine(line))
    .join('\n')
    .trim();
}

function cleanList(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(cleanBodyText)
    .filter(Boolean);
}

function normaliseLegalClaims(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(item => {
      if (typeof item === 'string') return { title: '', text: cleanBodyText(item) };
      return {
        title: cleanBodyText(item?.title || item?.heading || item?.label || ''),
        text: cleanBodyText(item?.text || item?.body || item?.claim || '')
      };
    })
    .filter(item => item.title || item.text);
}

function normaliseLetterStructure(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    opening_paragraphs: cleanList(source.opening_paragraphs || source.introduction || []),
    legal_claims: normaliseLegalClaims(source.legal_claims || source.claims || []),
    settlement_intro: cleanBodyText(source.settlement_intro || source.settlement_position || ''),
    settlement_terms: cleanList(source.settlement_terms || source.settlement_bullets || []),
    conclusion_paragraphs: cleanList(source.conclusion_paragraphs || source.conclusion || [])
  };
}

function letterStructureToPlainText(value = {}) {
  const structure = normaliseLetterStructure(value);
  const blocks = [];

  blocks.push(...structure.opening_paragraphs);

  structure.legal_claims.forEach((claim, index) => {
    const label = claim.title && claim.text
      ? `${claim.title}: ${claim.text}`
      : (claim.title || claim.text);
    if (label) blocks.push(`${index + 1}. ${label}`);
  });

  if (structure.settlement_intro) blocks.push(structure.settlement_intro);
  structure.settlement_terms.forEach(term => blocks.push(`• ${term}`));
  blocks.push(...structure.conclusion_paragraphs);

  return blocks.filter(Boolean).join('\n\n').trim();
}

function parsePlainDraftToBlocks(draft = '') {
  const cleanDraft = cleanBodyText(draft);
  if (!cleanDraft) return [];

  const rawBlocks = cleanDraft
    .split(/\n\s*\n+/)
    .map(block => block.trim())
    .filter(Boolean);

  return rawBlocks.map(block => {
    const numbered = block.match(/^(\d+)\.\s+([\s\S]+)$/);
    if (numbered) return { type: 'numbered', number: Number(numbered[1]), text: cleanBodyText(numbered[2]) };

    const bullet = block.match(/^[•*-]\s+([\s\S]+)$/);
    if (bullet) return { type: 'bullet', text: cleanBodyText(bullet[1]) };

    return { type: 'paragraph', text: cleanBodyText(block) };
  }).filter(block => block.text);
}

function structureToBlocks(value = {}) {
  const structure = normaliseLetterStructure(value);
  const blocks = [];

  structure.opening_paragraphs.forEach(text => blocks.push({ type: 'paragraph', text }));
  structure.legal_claims.forEach((claim, index) => {
    blocks.push({
      type: 'numbered',
      number: index + 1,
      title: claim.title,
      text: claim.text
    });
  });
  if (structure.settlement_intro) blocks.push({ type: 'paragraph', text: structure.settlement_intro });
  structure.settlement_terms.forEach(text => blocks.push({ type: 'bullet', text }));
  structure.conclusion_paragraphs.forEach(text => blocks.push({ type: 'paragraph', text }));

  return blocks;
}

function blocksForApprovedDraft({ draft = '', structure = null } = {}) {
  const approvedText = cleanBodyText(draft);
  if (structure) {
    const canonical = letterStructureToPlainText(structure);
    if (canonical && canonical === approvedText) return structureToBlocks(structure);
  }
  return parsePlainDraftToBlocks(approvedText);
}

module.exports = {
  cleanBodyText,
  normaliseLetterStructure,
  letterStructureToPlainText,
  parsePlainDraftToBlocks,
  structureToBlocks,
  blocksForApprovedDraft
};
