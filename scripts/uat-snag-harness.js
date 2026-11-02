const assert = require('assert');
const fs = require('fs');

const { renderReleasedLetterPdf } = require('../netlify/functions/lib/pdfDocument');
const { buildWhatsAppTemplatePayload } = require('../netlify/functions/lib/whatsapp');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

async function run() {
  const results = [];
  const test = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log('PASS', name);
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      console.error('FAIL', name, '-', error.message);
    }
  };

  await test('Claude request payloads contain no deprecated temperature', async () => {
    for (const path of [
      'netlify/functions/lib/llmGovernance.js',
      'netlify/functions/lib/intakeConversation.js',
      'netlify/functions/lib/determinationExplanation.js',
      'netlify/functions/lib/claudeDrafting.js'
    ]) {
      assert(!/temperature\s*:/.test(read(path)), path + ' still contains temperature');
    }
  });

  await test('Web intake cap is 15', async () => {
    assert(read('index.html').includes('const WEB_PROMPT_LIMIT = 15;'));
  });

  await test('PDFKit font metrics are included in Netlify bundle', async () => {
    assert(read('netlify.toml').includes('node_modules/pdfkit/js/data/**'));
  });

  await test('PDF renderer produces a real PDF', async () => {
    const pdf = await renderReleasedLetterPdf({
      caseId: 'uat-harness-case',
      facts: {
        client_name: 'Test Client',
        employer_name: 'Test Employer',
        employer_contact_email: 'employer@example.com',
        case_reference: 'UAT-TEST-001',
        letter_subject: 'Employment matter'
      },
      draft: 'Test paragraph.\n\n1. Numbered paragraph.\n\n• Settlement term.',
      approvedAt: new Date().toISOString()
    });
    assert(Buffer.isBuffer(pdf.buffer));
    assert.strictEqual(pdf.buffer.slice(0, 5).toString('ascii'), '%PDF-');
    assert(pdf.filename.endsWith('.pdf'));
    assert.strictEqual(pdf.content_type, 'application/pdf');
  });

  await test('Employer email remains WP and PDF-only', async () => {
    const source = read('netlify/functions/lib/email.js');
    assert(source.includes('WITHOUT PREJUDICE AND SUBJECT TO CONTRACT'));
    assert(source.includes("document.contentType || 'application/pdf'"));
  });

  await test('WhatsApp template builder creates Meta components payload', async () => {
    const payload = buildWhatsAppTemplatePayload({
      templateName: 'uat_payment_confirmed',
      languageCode: 'en',
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: 'Test Client' }]
      }]
    });
    assert.strictEqual(payload.type, 'template');
    assert.strictEqual(payload.template.language.code, 'en');
    assert.strictEqual(payload.template.components[0].parameters[0].text, 'Test Client');
  });

  await test('Payment link delivery falls back after template failure', async () => {
    const source = read('netlify/functions/approve_case_for_payment.js');
    assert(source.includes('session_text_after_template_failure'));
    assert(source.includes('falling back to active-session text'));
  });

  await test('Payment confirmation uses components and fallback', async () => {
    const source = read('netlify/functions/payfast_itn.js');
    assert(!source.includes('bodyParameters:'));
    assert(source.includes("components: [{"));
    assert(source.includes('session_text_after_template_failure'));
  });

  await test('Release no longer depends on downloading stored DOCX', async () => {
    const source = read('netlify/functions/manage_letter_release.js');
    assert(!source.includes('downloadStoredLetter'));
  });

  await test('PDF generation failure is audited and remains retryable', async () => {
    const source = read('netlify/functions/manage_letter_release.js');
    assert(source.includes("letter_send_failure_stage: releasedPdf ? 'email_delivery' : 'pdf_generation'"));
    assert(source.includes("letter_status: 'client_approved'"));
    assert(source.includes('the exact client-approved version remains ready for retry'));
  });

  const failed = results.filter(x => !x.ok);
  console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed }, null, 2));
  if (failed.length) process.exit(1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
