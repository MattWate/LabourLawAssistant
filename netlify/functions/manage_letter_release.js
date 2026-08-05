const { createClient } = require('@supabase/supabase-js');
const { sendApprovedLetter } = require('./lib/email');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('./lib/whatsapp');

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
  return cleanEmail(
    facts.employer_email ||
    facts.employer_contact_email ||
    facts.employer_contact_details ||
    caseData.employer_email
  );
}

function clientEmail(caseData, facts) {
  return cleanEmail(
    facts.client_email ||
    facts.email ||
    facts.contact_email ||
    caseData.client_email ||
    caseData.contact_info
  );
}

async function paymentConversation(caseId) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('from_number,phone_number_id')
    .eq('case_id', caseId)
    .maybeSingle();
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
        bodyParameters: [clientName, employerName]
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!supabase) throw new Error('Supabase is not configured');
    const user = await authenticate(event);
    const request = JSON.parse(event.body || '{}');
    const caseId = request.caseId;
    const action = String(request.action || '').trim().toLowerCase();
    if (!caseId) return json(400, { error: 'Case ID required' });
    if (!['save', 'approve', 'send'].includes(action)) return json(400, { error: 'Action must be save, approve or send' });

    const { data: caseData, error: caseError } = await supabase
      .from('cases')
      .select('*')
      .eq('id', caseId)
      .single();
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
        letter_approved_by: null
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
      const updatedFacts = {
        ...facts,
        wp_letter_status: 'APPROVED',
        letter_last_edited_at: draft !== String(caseData.draft_letter || '').trim() ? now : facts.letter_last_edited_at,
        letter_last_edited_by: draft !== String(caseData.draft_letter || '').trim() ? (user.email || user.id) : facts.letter_last_edited_by,
        letter_approved_at: now,
        letter_approved_by: user.email || user.id
      };
      const { error } = await supabase.from('cases').update({
        draft_letter: draft,
        status: 'letter_approved_ready_to_send',
        letter_status: 'approved',
        case_facts: updatedFacts,
        updated_at: now
      }).eq('id', caseId);
      if (error) throw error;
      return json(200, { success: true, action: 'approve', letter_status: 'approved' });
    }

    if (caseData.letter_status !== 'approved') {
      return json(409, { error: 'Approve the letter before sending it' });
    }
    if (!draft) return json(400, { error: 'The approved letter is empty' });
    if (draft !== String(caseData.draft_letter || '').trim()) {
      return json(409, { error: 'The letter has changed since approval. Save and approve the revised version before sending.' });
    }

    const to = employerEmail(caseData, facts);
    if (!to) return json(400, { error: 'A valid employer email address is required before release' });
    const cc = clientEmail(caseData, facts);

    const emailResult = await sendApprovedLetter({
      employerEmail: to,
      clientEmail: cc,
      clientName: facts.client_name || caseData.client_name,
      employerName: facts.employer_name,
      letter: draft,
      caseId
    });

    const notification = await notifyLetterSent(caseData, facts);
    const sentAt = new Date().toISOString();
    const updatedFacts = {
      ...facts,
      wp_letter_status: 'SENT',
      letter_sent_at: sentAt,
      letter_sent_by: user.email || user.id,
      letter_sent_to: to,
      letter_sent_cc: cc || null,
      resend_message_id: emailResult?.id || null,
      letter_sent_notification: notification
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
      copied_to: cc,
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
