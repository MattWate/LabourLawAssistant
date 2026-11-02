const { classifyAndHydrateMatter } = require('./lib/llmGovernance');
const { renderReleasedLetterPdf } = require('./lib/pdfDocument');
const { buildWhatsAppTemplatePayload } = require('./lib/whatsapp');

function result(name, ok, detail = {}) {
  return { name, ok: Boolean(ok), ...detail };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const tests = [];

  try {
    const governance = await classifyAndHydrateMatter({
      narrative: 'I was dismissed for alleged misconduct on 15 October 2026. I deny the allegation and no disciplinary hearing was held.',
      existingFacts: {}
    });
    tests.push(result('claude_governance_live', governance.ok && governance.source === 'claude', {
      source: governance.source,
      track: governance.primary_track,
      status: governance.log?.status || null,
      error: governance.log?.error || null
    }));
  } catch (error) {
    tests.push(result('claude_governance_live', false, { error: error.message }));
  }

  try {
    const pdf = await renderReleasedLetterPdf({
      caseId: 'uat-harness-case',
      facts: {
        client_name: 'Test Client',
        employer_name: 'Test Employer',
        employer_contact_email: 'employer@example.com',
        case_reference: 'UAT-TEST-001',
        letter_subject: 'Employment matter'
      },
      draft: 'This is a controlled UAT test paragraph.\n\n1. This is a numbered test paragraph.\n\n• This is a test settlement term.',
      approvedAt: new Date().toISOString()
    });
    const header = pdf.buffer.slice(0, 5).toString('ascii');
    tests.push(result('pdf_generation', header === '%PDF-', {
      filename: pdf.filename,
      bytes: pdf.buffer.length,
      header
    }));
  } catch (error) {
    tests.push(result('pdf_generation', false, { error: error.message }));
  }

  try {
    const payload = buildWhatsAppTemplatePayload({
      templateName: 'uat_payment_confirmed',
      languageCode: 'en',
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: 'Test Client' }]
      }]
    });
    const ok = payload?.type === 'template' &&
      payload?.template?.language?.code === 'en' &&
      payload?.template?.components?.[0]?.parameters?.[0]?.text === 'Test Client';
    tests.push(result('whatsapp_template_payload', ok, { payload }));
  } catch (error) {
    tests.push(result('whatsapp_template_payload', false, { error: error.message }));
  }

  const allPassed = tests.every(test => test.ok);
  return {
    statusCode: allPassed ? 200 : 500,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      harness: 'TEMPORARY_UAT_SNAG_HARNESS',
      all_passed: allPassed,
      tested_at: new Date().toISOString(),
      tests
    }, null, 2)
  };
};
