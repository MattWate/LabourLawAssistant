const fs=require('fs');
const { execFileSync }=require('child_process');

function assert(v,m){ if(!v) throw new Error(m); }
function syntax(p){ execFileSync(process.execPath,['--check',p],{stdio:'inherit'}); }

for(const p of [
  'netlify/functions/approve_case_for_payment.js',
  'netlify/functions/create_payfast_payment.js',
  'netlify/functions/payfast_itn.js',
  'netlify/functions/generate_letter.js',
  'netlify/functions/generate_letter-background.js',
  'netlify/functions/manage_letter_release.js',
  'netlify/functions/client_letter_review.js',
  'netlify/functions/client_case_consent.js'
]) syntax(p);

const create=fs.readFileSync('netlify/functions/create_payfast_payment.js','utf8');
const itn=fs.readFileSync('netlify/functions/payfast_itn.js','utf8');
const approve=fs.readFileSync('netlify/functions/approve_case_for_payment.js','utf8');
const release=fs.readFileSync('netlify/functions/manage_letter_release.js','utf8');

assert(create.includes("facts.client_email || facts.contact_email || facts.contact_info"),'PayFast must prefer client email');
assert(create.includes("notify_url: process.env.PAYFAST_NOTIFY_URL || `${site}/.netlify/functions/payfast_itn`"),'PayFast ITN callback missing');
assert(itn.includes("status: 'paid_ready_for_drafting'"),'ITN must unlock paid case for drafting');
assert(itn.includes("wp_generation_unlocked: true"),'ITN must unlock letter generation');
assert(itn.includes("amount_mismatch") && itn.includes("case_mismatch"),'ITN safety checks missing');
assert(approve.includes("create_payfast_payment"),'Approval must still call payment creation');
assert(approve.includes("sendPaymentRequest"),'Approval must still issue payment request');
assert(release.includes("sendClientReviewInvitation"),'Client review email flow missing');
assert(release.includes("caseData.letter_status !== 'client_approved'"),'Client approval release gate missing');
assert(release.includes("facts.client_letter_approved_hash !== sha256(draft)"),'Exact client-approved hash gate missing');
assert(release.includes("renderReleasedLetterPdf"),'Released PDF generation missing');
assert(release.includes("sendApprovedLetter"),'Employer email release missing');
assert(release.includes("letter_status: 'client_approved'"),'Retry-safe send failure state missing');

const { renderReleasedLetterPdf }=require('../netlify/functions/lib/pdfDocument');
(async()=>{
  const pdf=await renderReleasedLetterPdf({
    caseId:'test-case-1234',
    approvedAt:'2026-11-17T09:00:00Z',
    facts:{
      client_name:'Test Client',
      employer_name:'Example Employer (Pty) Ltd',
      employer_email:'hr@example.com',
      case_reference:'VRS-TEST-001',
      dismissal_reason_type:'Misconduct'
    },
    draft:'Without Prejudice, Private & Confidential\n\nBackground\n\n1. This is a test letter.\n\nLegal Claims\n\n2. The claim is disputed.\n\nWithout Prejudice Settlement Proposal\n\n• Compensation on an ex gratia basis.\n\nPlease respond within seven days.'
  });
  assert(pdf.buffer && pdf.buffer.length>500,'Released PDF did not render');
  assert(/\.pdf$/i.test(pdf.filename),'Released PDF filename invalid');
  console.log('PASS released PDF render',pdf.filename,pdf.buffer.length);
  console.log('ALL COMMERCIAL FLOW CHECKS PASSED');
})().catch(e=>{console.error(e);process.exit(1)});
