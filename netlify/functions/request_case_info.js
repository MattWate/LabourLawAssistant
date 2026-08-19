const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('./lib/whatsapp');
const { sendEmail } = require('./lib/email');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

async function authenticate(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('Unauthorized');
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized');
  return data.user;
}

function extractEmail(value = '') {
  return String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
}

function clean(value = '') {
  return String(value || '').trim();
}

async function deliverWhatsApp({ caseId, caseData, question }) {
  const { data: conversation, error } = await supabase
    .from('whatsapp_conversations')
    .select('from_number,phone_number_id')
    .eq('case_id', caseId)
    .maybeSingle();
  if (error) throw error;
  if (!conversation?.from_number) throw new Error('No WhatsApp conversation is linked to this case');

  const facts = caseData.case_facts || {};
  const clientName = facts.client_name || caseData.client_name || 'Client';
  const phoneNumberId = conversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = clean(process.env.WHATSAPP_INFO_REQUEST_TEMPLATE_NAME);
  const languageCode = clean(process.env.WHATSAPP_INFO_REQUEST_TEMPLATE_LANGUAGE || 'en');

  if (templateName) {
    await sendWhatsAppTemplate({
      to: conversation.from_number,
      phoneNumberId,
      templateName,
      languageCode,
      bodyParameters: [clientName, question]
    });
    return { sent: true, mode: 'whatsapp_template', recipient: conversation.from_number, template_name: templateName, template_language: languageCode };
  }

  await sendWhatsAppText({
    to: conversation.from_number,
    phoneNumberId,
    body: `Hi ${clientName}, the VRS legal team is reviewing your matter and needs some additional information:\n\n${question}\n\nPlease reply to this message with the information requested.`
  });
  return { sent: true, mode: 'whatsapp_session_text', recipient: conversation.from_number };
}

async function deliverEmail({ caseData, question }) {
  const facts = caseData.case_facts || {};
  const clientName = facts.client_name || caseData.client_name || 'Client';
  const clientEmail = facts.client_email || extractEmail(facts.contact_info || caseData.contact_info);
  if (!clientEmail) throw new Error('No client email address is recorded for this case');

  const result = await sendEmail({
    to: clientEmail,
    subject: 'VRS requires some additional information',
    text: `Hi ${clientName},\n\nThe VRS legal team is reviewing your matter and needs some additional information:\n\n${question}\n\nPlease reply to VRS with the information requested.\n\nRegards,\nVRS Labour Law Consultants`,
    html: `<div style="font-family:Arial,sans-serif;max-width:720px;margin:auto;color:#172033;line-height:1.6"><p>Hi ${clientName},</p><p>The VRS legal team is reviewing your matter and needs some additional information:</p><p><strong>${question.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</strong></p><p>Please reply to VRS with the information requested.</p><p>Regards,<br>VRS Labour Law Consultants</p></div>`
  });

  return { sent: true, mode: 'email', recipient: clientEmail, resend_id: result?.id || null };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!supabase) return json(500, { error: 'Supabase is not configured' });

  try {
    const user = await authenticate(event);
    const body = JSON.parse(event.body || '{}');
    const caseId = body.caseId || body.case_id;
    const question = clean(body.question);
    const channel = clean(body.channel || 'whatsapp').toLowerCase();
    const answerType = clean(body.answer_type || body.answerType || 'text');

    if (!caseId) return json(400, { error: 'caseId is required' });
    if (!question) return json(400, { error: 'Question is required' });
    if (!['whatsapp', 'email', 'phone', 'manual'].includes(channel)) return json(400, { error: 'Unsupported request channel' });

    const { data: caseData, error } = await supabase
      .from('cases')
      .select('*')
      .eq('id', caseId)
      .single();
    if (error || !caseData) return json(404, { error: 'Case not found' });

    let delivery = { sent: false, mode: channel === 'phone' || channel === 'manual' ? 'record_only' : channel };
    if (channel === 'whatsapp') delivery = await deliverWhatsApp({ caseId, caseData, question });
    if (channel === 'email') delivery = await deliverEmail({ caseData, question });

    const now = new Date().toISOString();
    const facts = caseData.case_facts || {};
    const questions = Array.isArray(facts.client_questions) ? [...facts.client_questions] : [];
    const request = {
      id: crypto.randomUUID(),
      question,
      channel,
      answer_type: answerType,
      status: 'pending',
      created_at: now,
      sent_at: delivery.sent ? now : null,
      created_by: user.email || user.id,
      return_status: caseData.status && caseData.status !== 'needs_more_info' ? caseData.status : 'requires_attorney',
      delivery,
      answered_at: null,
      answer: null
    };
    questions.push(request);

    const { error: updateError } = await supabase.from('cases').update({
      status: 'needs_more_info',
      case_facts: {
        ...facts,
        client_questions: questions,
        last_info_request_at: now,
        last_info_request_channel: channel
      },
      updated_at: now
    }).eq('id', caseId);
    if (updateError) throw updateError;

    return json(200, { success: true, request, delivery });
  } catch (error) {
    console.error('request_case_info error:', error);
    return json(error.message === 'Unauthorized' ? 401 : 500, { error: error.message });
  }
};
