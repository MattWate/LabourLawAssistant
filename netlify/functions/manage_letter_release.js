const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendApprovedLetter, sendClientReviewInvitation, sendEmail } = require('./lib/email');
const { compareClientEmployerEmail } = require('./lib/emailPrivacy');
const { assertReleaseAuthorised } = require('./lib/releaseAuthorization');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('./lib/whatsapp');
const {
  sha256,
  renderLetterDocument,
  storeLetterDocument,
  downloadStoredLetter
} = require('./lib/letterDocument');
const { renderReleasedLetterPdf } = require('./lib/pdfDocument');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function authenticate(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Unauthorized: Missing Authentication Token');
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized: Invalid or expired token');
  return data.user;
}

function cleanEmail(value) {
  const text = String(value || '').trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function employerEmail(caseData, facts) {
  return cleanEmail(facts.employer_email || facts.employer_contact_email || facts.employer_contact_details || caseData.employer_email);
}

function clientEmail(caseData, facts) {
  return cleanEmail(facts.client_email || facts.email || facts.contact_email || caseData.client_email || caseData.contact_info);
}

function siteBaseUrl(event) {
  const host = event.headers?.host || event.headers?.['x-forwarded-host'];
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  const configured = process.env.DEPLOY_PRIME_URL || process.env.URL;
  if (configured) return configured.replace(/\/$/, '');
  throw new Error('Could not determine site URL for client review');
}

function issueClientReview(event, draft) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  return {
    token,
    tokenHash,
    expiresAt,
    letterHash: sha256(draft),
    url: `${siteBaseUrl(event)}/client-letter-review.html?token=${encodeURIComponent(token)}`
  };
}

async function paymentConversation(caseId) {
  const { data } = await supabase.from('whatsapp_conversations').select('from_number,phone_number_id').eq('case_id', caseId).maybeSingle();
  return data || null;
}

async function notifyLetterSent(caseData, facts) {
  const conversation = await paymentConversation(caseData.id);
  if (!conversation?.from_number) return { sent: false, mode: 'none' };
  const clientName = facts.client_name || caseData.client_name || 'Client';
  const employerName = facts.employer_name || 'your employer';
  const templateName = String(process.env.WHATSAPP_LETTER_SENT_TEMPLATE_NAME || '').trim();
  const languageCode = String(process.env.WHATSAPP_LETTER_SENT_TEMPLATE_LANGUAGE || 'en').trim();
  const phoneNumberId = conversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

  try {
    if (templateName) {
      await sendWhatsAppTemplate({
        to: conversation.from_number,
        phoneNumberId,
        templateName,
        languageCode,
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: clientName },
            { type: 'text', text: employerName }
          ]
        }]
      });
      return { sent: true, mode: 'template', template_name: templateName, language_code: languageCode };
    }
    await sendWhatsAppText({
      to: conversation.from_number,
      phoneNumberId,
      body: `Hi ${clientName}, VRS has approved and sent your letter to ${employerName}. A copy was also sent to you where an email address was available.`
    });
    return { sent: true, mode: 'session_text' };
  } catch (error) {
    console.error('Letter sent WhatsApp notification failed:', error.message);
    return { sent: false, mode: templateName ? 'template_failed' : 'session_text_failed', error: error.message };
  }
}

async function generateApprovedDocument({ caseData, facts, draft, user, approvedAt }) {
  const document = renderLetterDocument({ caseId: caseData.id, facts, draft, approvedAt });
  const stored = await storeLetterDocument({ supabase, caseId: caseData.id, document });
  return {
    document,
    facts: {
      ...facts,
      approved_text_hash: document.approved_text_hash,
      letter_document_bucket: stored.bucket,
      letter_document_path: stored.path,
      letter_document_filename: document.filename,
      letter_document_template: document.template_name,
      letter_document_generated_at: new Date().toISOString(),
      letter_document_generated_by: user.email || user.id
    }
  };
}

async function alertVrsSendFailure({ caseData, facts, error, user }) {
  const recipients = String(process.env.VRS_ALERT_EMAILS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'VRS_ALERT_EMAILS not configured' };

  try {
    const result = await sendEmail({
      to: recipients,
      subject: `Justine alert: letter send failed for ${facts.case_reference || caseData.id}`,
      text: `A released letter failed to send.\n\nCase: ${facts.case_reference || caseData.id}\nClient: ${facts.client_name || caseData.client_name || 'Unknown'}\nAttempted by: ${user.email || user.id}\nError: ${String(error.message || error)}\n\nPlease review the case in Justine.`
    });
    return { sent: true, message_id: result?.id || null };
  } catch (alertError) {
    console.error('VRS send-failure alert could not be delivered:', alertError.message);
    return { sent: false, error: alertError.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!supabase) throw new Error('Supabase is not configured');
    const user = await authenticate(event);
    const request = JSON.parse(event.body || '{}');
    const caseId = request.caseId;
    const action = String(request.action || '').trim().toLowerCase();
    if (!caseId) return json(400, { error: 'Case ID required' });
    if (!['save', 'approve', 'regenerate', 'send'].includes(action)) return json(400, { error: 'Action must be save, approve, regenerate or send' });

    const { data: caseData, error: caseError } = await supabase.from('cases').select('*').eq('id', caseId).single();
    if (caseError || !caseData) return json(404, { error: 'Case not found' });

    const facts = caseData.case_facts || {};
    const now = new Date().toISOString();
    const draft = String(request.draft_letter ?? caseData.draft_letter ?? '').trim();

    if (action === 'save') {
      if (!draft) return json(400, { error: 'The draft letter is empty' });
      const updatedFacts = {
        ...facts,
        wp_letter_status: 'GENERATED_PENDING',
        letter_last_edited_at: now,
        letter_last_edited_by: user.email || user.id,
        letter_approved_at: null,
        letter_approved_by: null,
        approved_text_hash: null,
        letter_document_path: null,
        letter_document_filename: null
      };
      const { error } = await supabase.from('cases').update({
        draft_letter: draft,
        status: 'draft_ready_for_review',
        letter_status: 'pending_review',
        case_facts: updatedFacts,
        updated_at: now
      }).eq('id', caseId);
      if (error) throw error;
      return json(200, { success: true, action: 'save', letter_status: 'pending_review' });
    }

    if (action === 'approve') {
      if (!draft) return json(400, { error: 'The draft letter is empty' });
      if (caseData.payment_status !== 'paid') return json(403, { error: 'The letter cannot be approved until payment is confirmed' });

      const reviewEmail = clientEmail(caseData, facts);
      if (!reviewEmail) return json(400, { error: 'A valid personal client email address is required before the letter can be sent for client approval' });

      const review = issueClientReview(event, draft);
      const baseFacts = {
        ...facts,
        wp_letter_status: 'APPROVED_INTERNAL',
        letter_last_edited_at: draft !== String(caseData.draft_letter || '').trim() ? now : facts.letter_last_edited_at,
        letter_last_edited_by: draft !== String(caseData.draft_letter || '').trim() ? (user.email || user.id) : facts.letter_last_edited_by,
        letter_approved_at: now,
        letter_approved_by: user.email || user.id,
        client_review_token_hash: review.tokenHash,
        client_review_expires_at: review.expiresAt,
        client_review_letter_hash: review.letterHash,
        client_review_issued_at: now,
        client_review_completed_at: null,
        client_review_outcome: null,
        client_letter_approved_at: null,
        client_letter_approved_hash: null,
        client_requested_changes: null
      };
      const generated = await generateApprovedDocument({ caseData, facts: baseFacts, draft, user, approvedAt: now });
      const approvedFacts = {
        ...generated.facts,
        client_review_letter_hash: generated.document.approved_text_hash
      };
      const { error } = await supabase.from('cases').update({
        draft_letter: draft,
        status: 'awaiting_client_approval',
        letter_status: 'awaiting_client_approval',
        case_facts: approvedFacts,
        updated_at: now
      }).eq('id', caseId);
      if (error) throw error;

      try {
        await sendClientReviewInvitation({
          clientEmail: reviewEmail,
          clientName: facts.client_name || caseData.client_name,
          employerName: facts.employer_name,
          caseReference: facts.case_reference || caseId,
          reviewUrl: review.url,
          expiresAt: review.expiresAt
        });
      } catch (reviewEmailError) {
        console.error('Client review invitation failed:', { caseId, error: reviewEmailError.message });
        return json(502, {
          error: 'The letter was approved internally, but the client review email could not be sent. Approve the letter again to issue a new review link.',
          client_review_pending: true
        });
      }

      return json(200, {
        success: true,
        action: 'approve',
        letter_status: 'awaiting_client_approval',
        client_review_sent: true,
        client_review_expires_at: review.expiresAt,
        document_ready: true,
        document_filename: generated.document.filename
      });
    }

    if (action === 'regenerate') {
      if (!['awaiting_client_approval', 'client_approved'].includes(caseData.letter_status)) return json(409, { error: 'Approve the letter before generating the final document' });
      if (!draft) return json(400, { error: 'The approved letter is empty' });
      if (draft !== String(caseData.draft_letter || '').trim()) return json(409, { error: 'The letter has changed since approval. Save and approve it again.' });
      const generated = await generateApprovedDocument({
        caseData,
        facts,
        draft,
        user,
        approvedAt: facts.letter_approved_at || now
      });
      const { error } = await supabase.from('cases').update({ case_facts: generated.facts, updated_at: now }).eq('id', caseId);
      if (error) throw error;
      return json(200, { success: true, action: 'regenerate', document_ready: true, document_filename: generated.document.filename });
    }

    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    let releaseAuth;
    try {
      releaseAuth = assertReleaseAuthorised({ user, authHeader });
    } catch (authError) {
      const status = authError.code === 'MFA_REQUIRED' ? 403 : 403;
      return json(status, { error: authError.message, code: authError.code || 'RELEASE_NOT_AUTHORISED' });
    }

    if (caseData.letter_status !== 'client_approved') return json(409, { error: 'The client must approve this exact letter before it can be sent to the employer' });
    if (!draft) return json(400, { error: 'The approved letter is empty' });
    if (draft !== String(caseData.draft_letter || '').trim()) return json(409, { error: 'The letter has changed since approval. Save and approve the revised version before sending.' });
    if (facts.approved_text_hash !== sha256(draft)) return json(409, { error: 'The generated document does not match the approved letter. Regenerate it before sending.' });
    if (facts.client_letter_approved_hash !== sha256(draft)) return json(409, { error: 'The current letter does not match the version approved by the client. Send it for client approval again.' });
    if (!facts.letter_document_path || !facts.letter_document_filename) return json(409, { error: 'Generate the final VRS document before sending.' });

    const to = employerEmail(caseData, facts);
    if (!to) return json(400, { error: 'A valid employer email address is required before release' });
    const cc = clientEmail(caseData, facts);
    if (cc) {
      const privacy = compareClientEmployerEmail({ clientEmail: cc, employerEmail: to });
      if (!privacy.ok) {
        return json(400, { error: 'The recorded client email appears to be employer-controlled. Add a personal client email before release.' });
      }
    }
    // Keep the approved DOCX stored privately for audit/reference, but release a PDF to the employer.
    await downloadStoredLetter({
      supabase,
      bucket: facts.letter_document_bucket || process.env.LETTER_DOCUMENT_BUCKET || 'case-documents',
      storagePath: facts.letter_document_path
    });
    const releasedPdf = await renderReleasedLetterPdf({
      caseId,
      facts,
      draft,
      approvedAt: facts.letter_approved_at || now
    });

    let emailResult;
    try {
      emailResult = await sendApprovedLetter({
        employerEmail: to,
        clientEmail: cc,
        clientName: facts.client_name || caseData.client_name,
        employerName: facts.employer_name,
        letter: draft,
        caseId,
        document: { filename: releasedPdf.filename, buffer: releasedPdf.buffer, contentType: releasedPdf.content_type }
      });
    } catch (sendError) {
      const failedAt = new Date().toISOString();
      const alert = await alertVrsSendFailure({ caseData, facts, error: sendError, user });
      const failedFacts = {
        ...facts,
        wp_letter_status: 'SEND_FAILED',
        letter_send_failed_at: failedAt,
        letter_send_failed_by: user.email || user.id,
        letter_send_failed_to: to,
        letter_send_failure_error: String(sendError.message || sendError),
        letter_send_failure_alert: alert,
        release_aal: releaseAuth?.aal || null,
        release_permission_source: releaseAuth?.permission_source || null
      };
      await supabase.from('cases').update({
        status: 'letter_send_failed',
        letter_status: 'send_failed',
        case_facts: failedFacts,
        updated_at: failedAt
      }).eq('id', caseId);
      return json(502, {
        error: 'The letter was not sent. The case has been marked as failed and VRS has been alerted where configured.',
        send_failed: true,
        alert
      });
    }

    const notification = await notifyLetterSent(caseData, facts);
    const sentAt = new Date().toISOString();
    const updatedFacts = {
      ...facts,
      wp_letter_status: 'SENT',
      letter_sent_at: sentAt,
      letter_sent_by: user.email || user.id,
      letter_sent_to: to,
      letter_sent_bcc: cc || null,
      resend_message_id: emailResult?.id || null,
      letter_sent_notification: notification,
      release_aal: releaseAuth?.aal || null,
      release_permission_source: releaseAuth?.permission_source || null,
      released_pdf_filename: releasedPdf.filename,
      client_letter_approved_at: facts.client_letter_approved_at,
      client_letter_approved_hash: facts.client_letter_approved_hash
    };

    const { error: updateError } = await supabase.from('cases').update({
      status: 'letter_sent',
      letter_status: 'sent',
      case_facts: updatedFacts,
      updated_at: sentAt
    }).eq('id', caseId);
    if (updateError) throw updateError;

    return json(200, {
      success: true,
      action: 'send',
      letter_status: 'sent',
      sent_to: to,
      blind_copied_to: cc,
      document_filename: releasedPdf.filename,
      resend_message_id: emailResult?.id || null,
      whatsapp_notification: notification
    });
  } catch (error) {
    const message = String(error.message || 'Unknown error');
    const statusCode = message.startsWith('Unauthorized') ? 401 : 500;
    console.error('Manage letter release error:', { message, stack: error.stack });
    return json(statusCode, { error: message });
  }
};
