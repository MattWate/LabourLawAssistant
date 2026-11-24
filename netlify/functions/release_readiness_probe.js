const crypto = require('crypto');
const { renderReleasedLetterPdf } = require('./lib/pdfDocument');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405,{error:'Method Not Allowed'});
  try {
    const pdf = await renderReleasedLetterPdf({
      caseId: 'release-readiness-probe',
      approvedAt: '2026-11-24T12:00:00Z',
      facts: {
        client_name: 'Release Readiness Test',
        employer_name: 'Example Employer (Pty) Ltd',
        employer_email: 'employer@example.com',
        addressee_name: 'HR Manager',
        addressee_position: 'Human Resources',
        case_reference: 'VRS-READINESS-PROBE',
        dismissal_reason_type: 'Misconduct',
        letter_subject: 'TEST EMPLOYMENT MATTER'
      },
      draft: [
        'Background',
        '',
        '1. This synthetic letter exists only to verify deployed PDF generation.',
        '',
        'Legal Claims',
        '',
        '1. Test claim: no external communication is sent by this probe.',
        '',
        'Without Prejudice Settlement Proposal',
        '',
        '• Test settlement term.',
        '',
        'This probe performs no email, payment or database action.'
      ].join('\n')
    });
    const hash = crypto.createHash('sha256').update(pdf.buffer).digest('hex');
    const header = pdf.buffer.subarray(0,5).toString('ascii');
    return json(200,{
      ok: true,
      runtime: 'netlify-function',
      filename: pdf.filename,
      content_type: pdf.content_type,
      bytes: pdf.buffer.length,
      sha256: hash,
      pdf_header: header,
      font_probe: 'quicksand+pdfkit'
    });
  } catch (error) {
    console.error('Release PDF readiness probe failed', error);
    return json(500,{
      ok:false,
      stage:'pdf_generation',
      error:String(error.message || error),
      stack_hint:String(error.stack || '').split('\n').slice(0,4)
    });
  }
};
