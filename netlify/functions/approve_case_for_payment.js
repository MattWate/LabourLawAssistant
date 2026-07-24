const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('./lib/whatsapp');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, serviceKey);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

async function authenticate(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('Unauthorized');
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error('Unauthorized');
  return data.user;
}

function extractEmail(value = '') {
  return String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
}

function isTemplateLookupError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('template') && (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('translation') ||
    message.includes('language')
  );
}

async function sendPaymentRequest({ conversation, caseData, payment }) {
  if (!conversation?.from_number) return { sent: false, mode: 'none' };

  const facts = caseData.case_facts || {};
  const clientName = facts.client_name || caseData.client_name || 'Client';
  const phoneNumberId = conversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = String(process.env.WHATSAPP_PAYMENT_TEMPLATE_NAME || 'payment_link_ready').trim();
  const configuredLanguage = String(process.env.WHATSAPP_PAYMENT_TEMPLATE_LANGUAGE || 'en').trim();

  if (templateName) {
    const languageCodes = [...new Set([configuredLanguage, 'en_US', 'en_GB', 'en'].filter(Boolean))];
    let lastError = null;

    for (const languageCode of languageCodes) {
      try {
        await sendWhatsAppTemplate({
          to: conversation.from_number,
          phoneNumberId,
          templateName,
          languageCode,
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: clientName },
              { type: 'text', text: payment.payment_url }
            ]
          }]
        });
        return {
          sent: true,
          mode: 'template',
          template_name: templateName,
          template_language: languageCode
        };
      } catch (error) {
        lastError = error;
        if (!isTemplateLookupError(error)) throw error;
      }
    }

    throw new Error(`WhatsApp template ${templateName} was not found for language codes ${languageCodes.join(', ')}. Confirm that the template is approved in the same WhatsApp Business Account as this phone number. Last Meta error: ${lastError?.message || 'unknown error'}`);
  }

  await sendWhatsAppText({
    to: conversation.from_number,
    phoneNumberId,
    body: `Hi ${clientName}, VRS has reviewed your case. To proceed, please complete payment here: ${payment.payment_url}. Once payment is received, the legal team will prepare and review your letter.`
  });
  return { sent: true, mode: 'session_text' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const lawyer = await authenticate(event);
    const body = JSON.parse(event.body || '{}');
    const caseId = body.caseId || body.case_id;
    if (!caseId) return json(400, { error: 'caseId is required' });

    const { data: caseData, error } = await supabase
      .from('cases')
      .select('*')
      .eq('id', caseId)
      .single();
    if (error || !caseData) return json(404, { error: 'Case not found' });

    if (caseData.payment_status === 'paid') return json(409, { error: 'This case has already been paid' });
    if (caseData.payment_status === 'pending' || caseData.status === 'payment_pending') {
      return json(409, { error: 'A payment request has already been created for this case' });
    }

    const facts = caseData.case_facts || {};
    const employerEmail = facts.employer_email || extractEmail(facts.employer_contact_details);
    const clientEmail = facts.client_email || extractEmail(facts.contact_info || caseData.contact_info);

    if (!employerEmail) return json(400, { error: 'Employer email is missing from the case' });

    const approvedAt = new Date().toISOString();
    const approvedFacts = {
      ...facts,
      wp_eligible: true,
      lawyer_approved: true,
      lawyer_approved_at: approvedAt,
      lawyer_approved_by: lawyer.email || lawyer.id,
      ...(clientEmail ? { client_email: clientEmail } : {}),
      employer_email: employerEmail
    };

    await supabase.from('cases').update({
      case_facts: approvedFacts,
      status: 'approved_for_payment',
      letter_status: caseData.letter_status || 'not_started',
      updated_at: approvedAt
    }).eq('id', caseId);

    const { handler: createPayment } = require('./create_payfast_payment');
    const paymentResponse = await createPayment({
      httpMethod: 'POST',
      body: JSON.stringify({ caseId, amount: body.amount })
    });
    const payment = JSON.parse(paymentResponse.body || '{}');
    if (paymentResponse.statusCode >= 400) throw new Error(payment.error || 'Could not create payment link');

    const { data: conversation } = await supabase
      .from('whatsapp_conversations')
      .select('from_number,phone_number_id')
      .eq('case_id', caseId)
      .maybeSingle();

    const delivery = await sendPaymentRequest({ conversation, caseData: { ...caseData, case_facts: approvedFacts }, payment });

    await supabase.from('cases').update({
      status: 'payment_pending',
      payment_status: 'pending',
      case_facts: {
        ...approvedFacts,
        payment_requested_at: new Date().toISOString(),
        payment_request_channel: delivery.mode,
        payment_template_name: delivery.template_name || null,
        payment_template_language: delivery.template_language || null,
        payment_url: payment.payment_url,
        payment_amount: payment.amount,
        payment_reference: payment.m_payment_id
      },
      updated_at: new Date().toISOString()
    }).eq('id', caseId);

    return json(200, {
      success: true,
      case_id: caseId,
      payment_url: payment.payment_url,
      amount: payment.amount,
      client_email: clientEmail,
      employer_email: employerEmail,
      whatsapp_sent: delivery.sent,
      whatsapp_mode: delivery.mode,
      template_name: delivery.template_name || null,
      template_language: delivery.template_language || null
    });
  } catch (error) {
    const status = error.message === 'Unauthorized' ? 401 : 500;
    console.error('approve_case_for_payment error:', error);
    return json(status, { error: error.message });
  }
};
