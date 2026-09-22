const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const {
  blocksForApprovedDraft,
  normaliseLetterStructure,
  letterStructureToPlainText,
  parsePlainDraftToBlocks
} = require('./letterStructure');

const TEMPLATE_NAME = 'VRS_WP_Template_Master_NEW.docx';
const STORAGE_BUCKET = process.env.LETTER_DOCUMENT_BUCKET || 'case-documents';
const BODY_SENTINEL = '__VRS_STRUCTURED_BODY__';
const BODY_FONT = 'Quicksand';
const BODY_FONT_SIZE_HALF_POINTS = 22; // 11pt

function safeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function safeFilename(value = '') {
  return safeText(value, 'Client')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Client';
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function formatDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function resolveTemplatePath() {
  const candidates = [
    path.join(process.cwd(), 'assets', 'templates', TEMPLATE_NAME),
    path.join(__dirname, '..', '..', '..', 'assets', 'templates', TEMPLATE_NAME),
    path.join('/var/task', 'assets', 'templates', TEMPLATE_NAME)
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`Letter template not found: ${TEMPLATE_NAME}`);
  return found;
}

function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runProperties({ bold = false, underline = false } = {}) {
  return `<w:rPr>` +
    `<w:rFonts w:ascii="${BODY_FONT}" w:hAnsi="${BODY_FONT}" w:eastAsia="${BODY_FONT}" w:cs="${BODY_FONT}"/>` +
    `<w:sz w:val="${BODY_FONT_SIZE_HALF_POINTS}"/><w:szCs w:val="${BODY_FONT_SIZE_HALF_POINTS}"/>` +
    (bold ? '<w:b/><w:bCs/>' : '') +
    (underline ? '<w:u w:val="single"/>' : '') +
    `</w:rPr>`;
}

function textRuns(value = '', options = {}) {
  const lines = String(value || '').split('\n');
  return lines.map((line, index) => {
    const text = `<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`;
    return `<w:r>${runProperties(options)}${index > 0 ? '<w:br/>' : ''}${text}</w:r>`;
  }).join('');
}

function paragraphProperties({ list = false, alignment = 'both', before = 0, after = 120 } = {}) {
  return `<w:pPr>` +
    `<w:jc w:val="${alignment}"/>` +
    `<w:spacing w:before="${before}" w:after="${after}" w:line="276" w:lineRule="auto"/>` +
    (list ? '<w:ind w:left="360" w:hanging="360"/>' : '') +
    `</w:pPr>`;
}

function paragraphXml(block) {
  if (!block || !block.text && !block.title) return '';

  if (block.type === 'heading') {
    return `<w:p>${paragraphProperties({ alignment: 'left', before: 120, after: 80 })}${textRuns(block.text, { bold: true, underline: true })}</w:p>`;
  }

  if (block.type === 'numbered') {
    const number = Number.isFinite(block.number) ? block.number : 1;
    const title = safeText(block.title);
    const text = safeText(block.text);
    const body = title
      ? textRuns(`${number}. `, { bold: true }) + textRuns(title, { bold: true }) + (text ? textRuns(`: ${text}`) : '')
      : textRuns(`${number}. `, { bold: true }) + textRuns(text);
    return `<w:p>${paragraphProperties({ list: true })}${body}</w:p>`;
  }

  if (block.type === 'bullet') {
    return `<w:p>${paragraphProperties({ list: true })}${textRuns('• ', { bold: true })}${textRuns(block.text)}</w:p>`;
  }

  return `<w:p>${paragraphProperties()}${textRuns(block.text)}</w:p>`;
}

function renderStructuredBodyXml({ draft, structure }) {
  const blocks = blocksForApprovedDraft({ draft, structure });
  if (!blocks.length) throw new Error('Approved letter body contains no renderable paragraphs');
  return blocks.map(paragraphXml).join('');
}

function injectStructuredBody(doc, { draft, structure }) {
  const zip = doc.getZip();
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('Word template is missing word/document.xml');

  const documentXml = documentFile.asText();
  const paragraphPattern = new RegExp(
    `<w:p(?:\\s[^>]*)?>(?:(?!</w:p>)[\\s\\S])*?${BODY_SENTINEL}(?:(?!</w:p>)[\\s\\S])*?</w:p>`
  );

  if (!paragraphPattern.test(documentXml)) return false;

  const bodyXml = renderStructuredBodyXml({ draft, structure });
  zip.file('word/document.xml', documentXml.replace(paragraphPattern, bodyXml));
  return true;
}

function structureForTemplate({ draft = '', structure = null } = {}) {
  const approvedText = safeText(draft);
  const normalised = structure ? normaliseLetterStructure(structure) : null;

  if (normalised) {
    const canonical = letterStructureToPlainText(normalised);
    if (canonical && canonical === approvedText) return normalised;
  }

  const blocks = parsePlainDraftToBlocks(approvedText);
  const opening = [];
  const claims = [];
  const settlementTerms = [];
  const conclusion = [];
  let phase = 'opening';

  blocks.forEach(block => {
    if (block.type === 'numbered') {
      phase = 'claims';
      claims.push({ title: '', text: safeText(block.text) });
      return;
    }

    if (block.type === 'bullet') {
      phase = 'settlement';
      settlementTerms.push(safeText(block.text));
      return;
    }

    if (phase === 'opening') opening.push(safeText(block.text));
    else if (phase === 'claims') {
      phase = 'settlement';
      conclusion.push(safeText(block.text));
    } else if (phase === 'settlement') {
      conclusion.push(safeText(block.text));
    } else {
      conclusion.push(safeText(block.text));
    }
  });

  let settlementIntro = '';
  if (conclusion.length && settlementTerms.length) settlementIntro = conclusion.shift() || '';

  return {
    opening_paragraphs: opening,
    legal_claims: claims,
    settlement_intro: settlementIntro,
    settlement_terms: settlementTerms,
    conclusion_paragraphs: conclusion
  };
}

function legacyBodyTemplateData({ draft = '', structure = null } = {}) {
  const body = structureForTemplate({ draft, structure });
  const opening = body.opening_paragraphs || [];
  const claims = body.legal_claims || [];
  const terms = body.settlement_terms || [];
  const conclusions = body.conclusion_paragraphs || [];

  const claimsText = claims.map((claim, index) => {
    const label = safeText(claim.title);
    const text = safeText(claim.text);
    if (label && text) return `${index + 1}. ${label}: ${text}`;
    return `${index + 1}. ${label || text}`;
  }).filter(Boolean).join('\n\n');

  const termValues = [...terms];
  if (termValues.length > 4) {
    termValues[3] = termValues.slice(3).join('\n• ');
    termValues.length = 4;
  }

  return {
    introduction: opening[0] || '',
    background: opening.slice(1).join('\n\n'),
    legal_claims_numbered: claimsText,
    settlement_context: body.settlement_intro || '',
    settlement_term_1: termValues[0] || '',
    settlement_term_2: termValues[1] || '',
    settlement_term_3: termValues[2] || '',
    settlement_term_4: termValues[3] || '',
    settlement_closing: conclusions[0] || '',
    response_deadline: conclusions[1] || '',
    rights_reserved: conclusions.slice(2).join('\n\n')
  };
}

function buildTemplateData({ caseId, facts = {}, draft = '', approvedAt }) {
  const clientName = safeText(facts.client_name, 'Client');
  const employerName = safeText(facts.employer_name, 'Employer');
  const signatoryName = safeText(process.env.VRS_DEFAULT_SIGNATORY || facts.signatory_name, 'Sasha-Lee van Wyk');
  const senderEmail = safeText(process.env.VRS_SENDER_EMAIL || facts.sender_email, 'info@vrslabourlaw.co.za');
  const reference = safeText(
    facts.case_reference || facts.our_reference || facts.vrs_reference,
    `VRS-${String((approvedAt ? new Date(approvedAt) : new Date()).getFullYear()).slice(-2)}-${String(caseId).replace(/-/g, '').slice(0, 12).toUpperCase()}`
  );
  const subject = safeText(
    facts.letter_subject || facts.subject_heading,
    facts.dismissal_reason_type ? `${facts.dismissal_reason_type.toUpperCase()} EMPLOYMENT MATTER` : 'EMPLOYMENT MATTER'
  );
  const employerEmail = safeText(facts.employer_email || facts.employer_contact_email, '');

  return {
    ...legacyBodyTemplateData({ draft, structure: facts.wp_letter_structure || null }),

    // Current VRS WP template placeholders
    recipient_name: safeText(facts.recipient_name || facts.employer_contact_name, ''),
    recipient_company: employerName,
    recipient_address_line_1: safeText(facts.recipient_address_line_1 || facts.employer_address_line_1, ''),
    recipient_address_line_2: safeText(facts.recipient_address_line_2 || facts.employer_address_line_2, ''),
    recipient_address_line_3: safeText(facts.recipient_address_line_3 || facts.employer_address_line_3, ''),
    delivery_method: safeText(facts.delivery_method, employerEmail ? `BY EMAIL: ${employerEmail}` : ''),
    case_reference: reference,
    letter_date: formatDate(approvedAt || new Date()),
    salutation: safeText(facts.letter_salutation, 'Dear Sir / Madam,'),
    subject_line: subject.toUpperCase(),
    letter_body: BODY_SENTINEL,
    signature_image_or_mark: safeText(facts.signature_image_or_mark, ''),

    // Legacy aliases retained for backwards-compatible templates
    our_reference: reference,
    sender_email: senderEmail,
    recipient_reference: safeText(facts.recipient_reference, ''),
    client_name: clientName.toUpperCase(),
    employer_name: employerName.toUpperCase(),
    subject_heading: subject.toUpperCase(),
    closing_sentence: safeText(facts.closing_sentence, 'It is trusted that you will find same to be in order.'),
    signatory_firm: safeText(process.env.VRS_FIRM_NAME, 'VRS LABOUR LAW CONSULTANTS'),
    signatory_name: signatoryName,
    electronic_signature_note: safeText(process.env.VRS_ELECTRONIC_SIGNATURE_NOTE, 'Not signed due to electronic submission')
  };
}

function renderLetterDocument({ caseId, facts = {}, draft, approvedAt }) {
  if (!caseId) throw new Error('Case ID is required for document generation');
  if (!safeText(draft)) throw new Error('Approved letter text is empty');

  const templatePath = resolveTemplatePath();
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => ''
  });

  const data = buildTemplateData({ caseId, facts, draft, approvedAt });
  doc.render(data);
  injectStructuredBody(doc, { draft, structure: facts.wp_letter_structure || null });

  const buffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename = `VRS_WP_${safeFilename(facts.client_name)}_${String(caseId).slice(0, 8).toUpperCase()}.docx`;

  return {
    buffer,
    filename,
    template_name: TEMPLATE_NAME,
    approved_text_hash: sha256(draft),
    template_data: data
  };
}

async function ensurePrivateBucket(supabase) {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;
  if ((buckets || []).some(bucket => bucket.name === STORAGE_BUCKET)) return;
  const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message || '')) throw error;
}

async function storeLetterDocument({ supabase, caseId, document }) {
  await ensurePrivateBucket(supabase);
  const storagePath = `cases/${caseId}/letters/${document.filename}`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, document.buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true
    });
  if (error) throw error;
  return { bucket: STORAGE_BUCKET, path: storagePath };
}

async function downloadStoredLetter({ supabase, bucket = STORAGE_BUCKET, storagePath }) {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

module.exports = {
  TEMPLATE_NAME,
  STORAGE_BUCKET,
  sha256,
  renderLetterDocument,
  storeLetterDocument,
  downloadStoredLetter
};
