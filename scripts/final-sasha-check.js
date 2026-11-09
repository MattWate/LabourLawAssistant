const assert = require('assert');
const PizZip = require('pizzip');
const fs = require('fs');
const {
  normaliseLetterStructure,
  letterStructureToPlainText,
  blocksForApprovedDraft
} = require('../netlify/functions/lib/letterStructure');
const { renderLetterDocument } = require('../netlify/functions/lib/letterDocument');
const { renderReleasedLetterPdf } = require('../netlify/functions/lib/pdfDocument');

async function main() {
  const structure = normaliseLetterStructure({
    opening_paragraphs: [
      'The client was employed by Test Employer and was dismissed following a disciplinary process.',
      'The client disputes the fairness of that dismissal.'
    ],
    legal_claims: [
      { title: 'Unfair dismissal', text: 'The dismissal is challenged on substantive and procedural grounds.' },
      { title: 'Breach of trust and confidence', text: 'The circumstances materially damaged the employment relationship.' }
    ],
    settlement_intro: 'In an effort to resolve the matter, our client proposes the following terms.',
    settlement_terms: [
      'Compensation to be agreed.',
      'Issue the UI-19 and certificate of service.'
    ],
    conclusion_paragraphs: [
      'Please respond within seven calendar days.',
      'All rights remain reserved.'
    ]
  });

  const draft = letterStructureToPlainText(structure);
  assert(draft.includes('Background\n\n1. The client was employed'));
  assert(draft.includes('Legal Claims\n\n1. Unfair dismissal:'));
  assert(draft.includes('Without Prejudice Settlement Proposal'));
  assert(draft.includes('• Compensation to be agreed.'));

  const blocks = blocksForApprovedDraft({ draft, structure });
  assert.strictEqual(blocks[0].type, 'heading');
  assert.strictEqual(blocks[0].text, 'Background');
  assert(blocks.some(b => b.type === 'heading' && b.text === 'Legal Claims'));
  assert(blocks.some(b => b.type === 'heading' && b.text === 'Without Prejudice Settlement Proposal'));
  assert(blocks.some(b => b.type === 'bullet'));

  const facts = {
    client_name: 'Test Client',
    employer_name: 'Test Employer',
    employer_email: 'hr@example.com',
    case_reference: 'UAT-WP-001',
    dismissal_reason_type: 'Misconduct',
    wp_letter_structure: structure
  };

  const docx = renderLetterDocument({
    caseId: '11111111-2222-3333-4444-555555555555',
    facts,
    draft,
    approvedAt: '2026-11-09T08:00:00.000Z'
  });
  assert(docx.buffer.length > 1000);
  const zip = new PizZip(docx.buffer);
  const xml = zip.file('word/document.xml').asText();
  const visible = xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  assert(visible.includes('Background'));
  assert(visible.includes('Legal Claims'));
  assert(visible.includes('Without Prejudice Settlement Proposal'));
  assert(xml.includes('Quicksand'));
  assert(!/Sasha-Lee de Beer/i.test(visible), 'DOCX still contains old Sasha-Lee de Beer signature');
  assert(!/VAN RENSBURG SCHOON/i.test(visible), 'DOCX still contains old Van Rensburg Schoon branding');
  assert(/Sasha-Lee van Wyk/i.test(visible), 'DOCX is missing Sasha-Lee van Wyk');
  assert(/Director\s*&\s*Labour Law Consultant/i.test(visible), 'DOCX is missing approved signatory title');

  const pdf = await renderReleasedLetterPdf({
    caseId: '11111111-2222-3333-4444-555555555555',
    facts,
    draft,
    approvedAt: '2026-11-09T08:00:00.000Z'
  });
  assert.strictEqual(pdf.buffer.slice(0,5).toString('ascii'), '%PDF-');
  assert(pdf.buffer.length > 1000);

  const ask = fs.readFileSync('netlify/functions/ask.js','utf8');
  assert(ask.includes('you may have a strong case for a possible unfair dismissal claim'));
  assert(ask.includes('it appears your employer followed a fair process and had a valid reason for their decision'));
  assert(ask.includes('though it is not a matter that calls for a Without Prejudice letter at this stage'));

  const consent = fs.readFileSync('netlify/functions/lib/consentConfig.js','utf8');
  assert(consent.includes('handled as confidential case information'));
  assert(consent.includes('explain what has happened at work in your own words'));

  const productionWa = fs.readFileSync('netlify/functions/lib/whatsappProductionConversation.js','utf8');
  assert(!productionWa.includes('VRS legal team'));

  console.log('PASS final Sasha requirement checks');
  console.log(JSON.stringify({
    docx_bytes: docx.buffer.length,
    pdf_bytes: pdf.buffer.length,
    headings: blocks.filter(b => b.type === 'heading').map(b => b.text)
  }, null, 2));
}
main().catch(err => { console.error(err.stack || err); process.exit(1); });
