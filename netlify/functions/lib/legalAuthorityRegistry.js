const AUTHORITIES = Object.freeze({
  LRA: {
    title: 'Labour Relations Act 66 of 1995',
    source: 'https://www.gov.za/documents/labour-relations-act',
    sections: new Set(['185','186','186(1)(e)','186(2)','186(2)(b)','186(2)(c)','187','187(1)(a)','187(1)(e)','187(1)(f)','188','188(1)','188A','189','189A','191','193','194','200A','203','203(2A)'])
  },
  BCEA: {
    title: 'Basic Conditions of Employment Act 75 of 1997',
    source: 'https://www.gov.za/documents/basic-conditions-employment-act',
    sections: new Set(['20','21','22','34','37','38','40','41','77','77A'])
  },
  EEA: {
    title: 'Employment Equity Act 55 of 1998',
    source: 'https://www.gov.za/documents/employment-equity-act',
    sections: new Set(['6','10','15','50'])
  },
  DISMISSAL_CODE_2025: {
    title: 'Code of Practice: Dismissal, 2025',
    source: 'https://www.gov.za/documents/notices/labour-relations-act-code-practice-dismissal-04-sep-2025',
    paragraphs: new Set(Array.from({ length: 24 }, (_, i) => String(i + 1))),
    published: '2025-09-04',
    gazette: '53294',
    notice: '3470 of 2025'
  }
});

function normaliseSection(value = '') {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^s(?:ection)?/i, '')
    .replace(/\.$/, '');
}

function draftText(draft = {}) {
  return JSON.stringify(draft?.part_a_letter || draft || {});
}

function extractStatutoryCitations(text = '') {
  const citations = [];
  const raw = String(text || '');

  const actPatterns = [
    { key: 'LRA', re: /(?:LRA|Labour Relations Act)(?:\s+(?:section|s))?\s*([0-9]{1,3}(?:A)?(?:\([0-9a-z]+\))?(?:\([0-9a-z]+\))?)/gi },
    { key: 'BCEA', re: /(?:BCEA|Basic Conditions of Employment Act)(?:\s+(?:section|s))?\s*([0-9]{1,3}(?:\([0-9a-z]+\))?(?:\([0-9a-z]+\))?)/gi },
    { key: 'EEA', re: /(?:EEA|Employment Equity Act)(?:\s+(?:section|s))?\s*([0-9]{1,3}(?:\([0-9a-z]+\))?(?:\([0-9a-z]+\))?)/gi }
  ];

  for (const { key, re } of actPatterns) {
    let match;
    while ((match = re.exec(raw)) !== null) citations.push({ authority: key, section: normaliseSection(match[1]), raw: match[0] });
  }

  const reversePatterns = [
    { key: 'LRA', re: /(?:section|s)\s*([0-9]{1,3}(?:A)?(?:\([0-9a-z]+\))?(?:\([0-9a-z]+\))?)\s+of\s+the\s+(?:LRA|Labour Relations Act)/gi },
    { key: 'BCEA', re: /(?:section|s)\s*([0-9]{1,3}(?:\([0-9a-z]+\))?(?:\([0-9a-z]+\))?)\s+of\s+the\s+(?:BCEA|Basic Conditions of Employment Act)/gi },
    { key: 'EEA', re: /(?:section|s)\s*([0-9]{1,3}(?:\([0-9a-z]+\))?(?:\([0-9a-z]+\))?)\s+of\s+the\s+(?:EEA|Employment Equity Act)/gi }
  ];
  for (const { key, re } of reversePatterns) {
    let match;
    while ((match = re.exec(raw)) !== null) citations.push({ authority: key, section: normaliseSection(match[1]), raw: match[0] });
  }

  const codeRe = /(?:Code of Practice:\s*Dismissal,\s*2025|the Code)(?:\s*,?\s*(?:paragraphs?|paras?\.?))\s*([0-9]{1,2})(?:\s*[-–]\s*([0-9]{1,2}))?/gi;
  let codeMatch;
  while ((codeMatch = codeRe.exec(raw)) !== null) {
    const start = Number(codeMatch[1]);
    const end = codeMatch[2] ? Number(codeMatch[2]) : start;
    for (let n = start; n <= end && n <= start + 30; n += 1) {
      citations.push({ authority: 'DISMISSAL_CODE_2025', paragraph: String(n), raw: codeMatch[0] });
    }
  }

  const reverseCodeRe = /(?:paragraphs?|paras?\.?)\s*([0-9]{1,2})(?:\s*[-–]\s*([0-9]{1,2}))?\s+of\s+(?:the\s+)?(?:Code of Practice:\s*Dismissal,\s*2025|Code)/gi;
  while ((codeMatch = reverseCodeRe.exec(raw)) !== null) {
    const start = Number(codeMatch[1]);
    const end = codeMatch[2] ? Number(codeMatch[2]) : start;
    for (let n = start; n <= end && n <= start + 30; n += 1) {
      citations.push({ authority: 'DISMISSAL_CODE_2025', paragraph: String(n), raw: codeMatch[0] });
    }
  }

  return citations;
}

function validateLegalAuthorities({ draft = {}, caseBrief = {} } = {}) {
  const text = draftText(draft);
  const lower = text.toLowerCase();
  const defects = [];
  const citations = extractStatutoryCitations(text);

  if (/schedule\s*8/i.test(text)) {
    defects.push('The outward-facing draft cites the repealed Schedule 8 Code. Use the Code of Practice: Dismissal, 2025.');
  }

  for (const citation of citations) {
    const authority = AUTHORITIES[citation.authority];
    if (!authority) continue;
    if (citation.section && !authority.sections.has(citation.section)) {
      defects.push(`Unverified or unsupported citation: ${citation.raw}. Use only a registry-backed statutory section or remove the citation.`);
    }
    if (citation.paragraph && !authority.paragraphs.has(citation.paragraph)) {
      defects.push(`Unverified Code paragraph: ${citation.raw}. The registered 2025 dismissal Code contains paragraphs 1-24.`);
    }
  }

  const track = String(caseBrief.track || '').toUpperCase();
  if (track === 'UD-MISCONDUCT') {
    const hasCode = citations.some(c => c.authority === 'DISMISSAL_CODE_2025');
    const miscParas = new Set(citations.filter(c => c.authority === 'DISMISSAL_CODE_2025').map(c => c.paragraph));
    if (hasCode && ![...miscParas].some(p => ['7','8','9','10','11'].includes(p))) {
      defects.push('Misconduct dismissal analysis cites the 2025 Code but not the registered misconduct/procedure paragraphs 7-11.');
    }
  }
  if (track === 'UD-POOR_PERFORMANCE') {
    const codeParas = citations.filter(c => c.authority === 'DISMISSAL_CODE_2025').map(c => c.paragraph);
    if (codeParas.length && !codeParas.some(p => ['19','20'].includes(p))) {
      defects.push('Poor-performance dismissal analysis must use the registered 2025 Code paragraphs 19-20 where the Code is cited.');
    }
  }
  if (track === 'UD-INCAPACITY') {
    const codeParas = citations.filter(c => c.authority === 'DISMISSAL_CODE_2025').map(c => c.paragraph);
    if (codeParas.length && !codeParas.includes('21')) {
      defects.push('Incapacity dismissal analysis must use registered 2025 Code paragraph 21 where the Code is cited.');
    }
  }
  if (track === 'UD-RETRENCHMENT') {
    const codeParas = citations.filter(c => c.authority === 'DISMISSAL_CODE_2025').map(c => c.paragraph);
    if (codeParas.length && !codeParas.some(p => ['22','23','24'].includes(p))) {
      defects.push('Operational-requirements analysis must use registered 2025 Code paragraphs 22-24 where the Code is cited.');
    }
  }

  if (/payment\s+(?:in\s+lieu|instead)\s+of\s+notice/i.test(text)) {
    const has37 = citations.some(c => c.authority === 'BCEA' && c.section === '37');
    const has38 = citations.some(c => c.authority === 'BCEA' && c.section === '38');
    if (has37 !== has38) defects.push('Notice-pay wording must pair BCEA section 37 (notice period) with section 38 (payment instead of notice).');
  }

  if (lower.includes('code of practice: dismissal') && !/code of practice:\s*dismissal,\s*2025/i.test(text)) {
    defects.push('The first dismissal-Code citation must identify the instrument as the Code of Practice: Dismissal, 2025.');
  }

  return { ok: defects.length === 0, defects: [...new Set(defects)], citations };
}

function verifiedAuthoritySummary() {
  return {
    LRA: { title: AUTHORITIES.LRA.title, sections: [...AUTHORITIES.LRA.sections], source: AUTHORITIES.LRA.source },
    BCEA: { title: AUTHORITIES.BCEA.title, sections: [...AUTHORITIES.BCEA.sections], source: AUTHORITIES.BCEA.source },
    EEA: { title: AUTHORITIES.EEA.title, sections: [...AUTHORITIES.EEA.sections], source: AUTHORITIES.EEA.source },
    dismissal_code_2025: {
      title: AUTHORITIES.DISMISSAL_CODE_2025.title,
      paragraphs: [...AUTHORITIES.DISMISSAL_CODE_2025.paragraphs],
      source: AUTHORITIES.DISMISSAL_CODE_2025.source,
      published: AUTHORITIES.DISMISSAL_CODE_2025.published,
      gazette: AUTHORITIES.DISMISSAL_CODE_2025.gazette
    }
  };
}

module.exports = {
  AUTHORITIES,
  extractStatutoryCitations,
  validateLegalAuthorities,
  verifiedAuthoritySummary
};
