const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('./lib/whatsapp');
const { determineProductRoute } = require('./lib/productRouting');
const { CONSENT_CONFIG } = require('./lib/consentConfig');
const { sendEmail } = require('./lib/email');

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
  const internalSecret = String(process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const suppliedInternal = String(event.headers?.['x-vrs-internal-payment-secret'] || event.headers?.['X-VRS-Internal-Payment-Secret'] || '').trim();
  if (internalSecret && suppliedInternal && suppliedInternal === internalSecret) {
    return { id: 'internal-whatsapp-consent', email: 'internal@vrs' };
  }

  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('Unauthorized');
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error('Unauthorized');
  return data.user;
}


function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function siteBaseUrl(event) {
  const host = event.headers?.host || event.headers?.['x-forwarded-host'];
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  const configured = process.env.DEPLOY_PRIME_URL || process.env.URL;
  if (configured) return configured.replace(/\/$/, '');
  throw new Error('Could not determine site URL');
}

async function sendEmailConsentRequest({ event, caseId, caseData, facts, stage }) {
  const clientEmail = facts.client_email || extractEmail(facts.contact_email || facts.contact_info || caseData.contact_info);
  if (!clientEmail) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const url = `${siteBaseUrl(event)}/client-consent.html?token=${encodeURIComponent(token)}`;
  const stageLabel = stage === 'mandate' ? 'VRS mandate' : 'pre-payment instruction';
  const updatedFacts = {
    ...facts,
    client_consent_token_hash: tokenHash,
    client_consent_expires_at: expiresAt,
    client_consent_stage: stage,
    client_consent_issued_at: now,
    client_consent_channel: 'email',
    client_consent_email: clientEmail
  };

  await supabase.from('cases').update({
    status: stage === 'mandate' ? 'awaiting_mandate_acceptance' : 'awaiting_payment_consent',
    case_facts: updatedFacts,
    updated_at: now
  }).eq('id', caseId);

  await sendEmail({
    to: clientEmail,
    subject: `Action required: confirm your ${stageLabel} — ${facts.case_reference || caseId}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#172033;line-height:1.6">
      <p>Hello ${facts.client_name || caseData.client_name || 'there'},</p>
      <p>VRS Labour Law Consultants needs your confirmation before the matter can move to payment.</p>
      <p><a href="${url}" style="display:inline-block;background:#20368F;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Review and confirm</a></p>
      <p>This private link expires in 24 hours.</p>
      <p>Regards,<br>VRS Labour Law Consultants</p>
    </div>`,
    text: `VRS Labour Law Consultants needs your confirmation before the matter can move to payment.\n\nReview and confirm here: ${url}\n\nThis private link expires in 24 hours.`
  });

  return { clientEmail, expiresAt, updatedFacts };
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

    console.warn('WhatsApp payment template unavailable; falling back to active-session text', {
      templateName,
      languageCodes,
      error: lastError?.message || 'unknown error'
    });
  }

  await sendWhatsAppText({
    to: conversation.from_number,
    phoneNumberId,
    body: `Hi ${clientName}, VRS has reviewed your case. To proceed, please complete payment here: ${payment.payment_url}. Once payment is received, the legal team will prepare and review your letter.`
  });
  return { sent: true, mode: templateName ? 'session_text_after_template_failure' : 'session_text' };
}


function normaliseWhatsAppNumber(value = '') {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) digits = '27' + digits.slice(1);
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function ensureMandateConversation(caseId, caseData, facts) {
  const { data: existing, error: readError } = await supabase
    .from('whatsapp_conversations')
    .select('id,from_number,phone_number_id')
    .eq('case_id', caseId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing?.from_number) return existing;

  const number = normaliseWhatsAppNumber(facts.whatsapp_number || facts.contact_info || caseData.contact_info);
  if (!number) return null;

  const now = new Date().toISOString();
  const payload = {
    from_number: number,
    contact_name: facts.client_name || caseData.client_name || null,
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    current_step: 'COMPLETE',
    status: 'completed',
    collected_facts: { ...facts, contact_info: number, whatsapp_number: number },
    case_id: caseId,
    handoff_reason: null,
    error_message: null,
    last_inbound_at: null,
    updated_at: now
  };

  const { data: byNumber } = await supabase
    .from('whatsapp_conversations')
    .select('id')
    .eq('from_number', number)
    .maybeSingle();

  if (byNumber?.id) {
    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .update(payload)
      .eq('id', byNumber.id)
      .select('id,from_number,phone_number_id')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .insert({ ...payload, processed_message_ids: [], created_at: now })
    .select('id,from_number,phone_number_id')
    .single();
  if (error) throw error;
  return data;
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
    const productRoute = determineProductRoute(facts);
    if (!productRoute.payment_allowed || productRoute.product_code !== 'WP_LETTER') {
      return json(409, { error: productRoute.reason || 'No payable product is available for this case', product_route: productRoute });
    }

    if (facts.mandate_acceptance?.accepted !== true) {
      const mandateConversation = await ensureMandateConversation(caseId, caseData, facts);

      if (!mandateConversation?.from_number) {
        const emailRequest = await sendEmailConsentRequest({ event, caseId, caseData, facts, stage: 'mandate' });
        if (!emailRequest) {
          return json(409, {
            error: 'Client mandate acceptance is required before payment can be requested. No usable WhatsApp number or client email is available.',
            mandate_required: true
          });
        }
        return json(202, {
          success: true,
          mandate_required: true,
          mandate_requested: true,
          email_sent: true,
          channel: 'email',
          message: 'The VRS mandate and consent link has been emailed to the client. The client can complete the required confirmations without WhatsApp.'
        });
      }

      const phoneNumberId = mandateConversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
      await sendWhatsAppText({
        to: mandateConversation.from_number,
        phoneNumberId,
        body: `${CONSENT_CONFIG.mandate.text}\n\nReply YES to confirm that you have read and accept the VRS Labour Law Consultants mandate.`
      });

      const now = new Date().toISOString();
      await supabase.from('whatsapp_conversations').update({
        status: 'awaiting_mandate_acceptance',
        updated_at: now
      }).eq('id', mandateConversation.id);

      await supabase.from('cases').update({
        status: 'awaiting_mandate_acceptance',
        case_facts: {
          ...facts,
          mandate_requested_at: now,
          mandate_version: CONSENT_CONFIG.mandate.version
        },
        updated_at: now
      }).eq('id', caseId);

      return json(202, {
        success: true,
        mandate_required: true,
        mandate_requested: true,
        message: 'The VRS mandate has been sent to the client on WhatsApp. Ask the client to reply YES before payment consent is requested.'
      });
    }

    if (facts.payment_start_consent?.accepted !== true) {
      const consentConversation = await ensureMandateConversation(caseId, caseData, facts);

      if (!consentConversation?.from_number) {
        const emailRequest = await sendEmailConsentRequest({ event, caseId, caseData, facts, stage: 'payment' });
        if (!emailRequest) {
          return json(409, {
            error: 'Client pre-payment consent is required before a payment link can be created. No usable WhatsApp number or client email is available.',
            consent_required: true
          });
        }
        return json(202, {
          success: true,
          consent_required: true,
          consent_requested: true,
          email_sent: true,
          channel: 'email',
          message: 'The pre-payment consent link has been emailed to the client. Once accepted, request payment again.'
        });
      }

      const phoneNumberId = consentConversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
      await sendWhatsAppText({
        to: consentConversation.from_number,
        phoneNumberId,
        body: `${CONSENT_CONFIG.pre_payment.text}\n\nReply YES to confirm.`
      });

      const now = new Date().toISOString();
      await supabase.from('whatsapp_conversations').update({
        status: 'awaiting_payment_consent',
        updated_at: now
      }).eq('id', consentConversation.id);

      await supabase.from('cases').update({
        status: 'awaiting_payment_consent',
        case_facts: {
          ...facts,
          payment_consent_requested_at: now,
          payment_consent_version: CONSENT_CONFIG.version
        },
        updated_at: now
      }).eq('id', caseId);

      return json(202, {
        success: true,
        consent_required: true,
        consent_requested: true,
        message: 'The approved pre-payment wording has been sent to the client on WhatsApp. Ask the client to reply YES, then request payment again.'
      });
    }

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
      headers: {
        authorization: event.headers?.authorization || event.headers?.Authorization || '',
        'x-vrs-internal-payment-secret': event.headers?.['x-vrs-internal-payment-secret'] || event.headers?.['X-VRS-Internal-Payment-Secret'] || ''
      },
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
