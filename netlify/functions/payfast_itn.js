const { createClient } = require('@supabase/supabase-js');
const { parseFormBody, verifyRawItnSignature, validateWithPayfast } = require('./lib/payfast');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('./lib/whatsapp');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function normaliseStatus(status = '') {
  const value = String(status || '').trim().toUpperCase();
  if (value === 'COMPLETE') return 'paid';
  if (value === 'FAILED') return 'failed';
  if (value === 'CANCELLED') return 'cancelled';
  if (value === 'PENDING') return 'pending';
  return value ? value.toLowerCase() : 'unknown';
}

function caseIdFrom(data = {}) {
  return data.custom_str1 || data.case_id || null;
}

function amountsMatch(expected, received) {
  const a = Number(expected);
  const b = Number(received);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

async function getExistingPayment(mPaymentId) {
  if (!supabase || !mPaymentId) return null;
  const { data, error } = await supabase
    .from('payments')
    .select('id, case_id, amount, m_payment_id')
    .eq('m_payment_id', mPaymentId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertPayment(data, checks) {
  if (!supabase) return null;

  const mPaymentId = data.m_payment_id || null;
  const payload = {
    provider: 'payfast',
    m_payment_id: mPaymentId,
    pf_payment_id: data.pf_payment_id || null,
    case_id: caseIdFrom(data),
    amount: data.amount_gross ? Number(data.amount_gross) : null,
    item_name: data.item_name || null,
    status: normaliseStatus(data.payment_status),
    raw_itn: data,
    signature_valid: checks.signatureValid,
    merchant_valid: checks.merchantValid,
    payfast_validation_status: checks.payfastValidationStatus,
    payfast_validation_response: checks.payfastValidationResponse,
    received_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!mPaymentId) {
    const { data: inserted, error } = await supabase.from('payments').insert(payload).select().single();
    if (error) throw error;
    return inserted;
  }

  const { data: existing, error: existingError } = await supabase
    .from('payments')
    .select('id, case_id')
    .eq('m_payment_id', mPaymentId)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existing?.id) {
    if (!payload.case_id && existing.case_id) delete payload.case_id;
    const { data: updated, error } = await supabase
      .from('payments')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return updated;
  }

  const { data: inserted, error } = await supabase.from('payments').insert(payload).select().single();
  if (error) throw error;
  return inserted;
}

async function paymentConversation(caseId) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('from_number,phone_number_id')
    .eq('case_id', caseId)
    .maybeSingle();
  return data || null;
}

async function notifyPaymentConfirmed(caseData) {
  const conversation = await paymentConversation(caseData.id);
  if (!conversation?.from_number) return { sent: false, mode: 'none' };

  const facts = caseData.case_facts || {};
  const clientName = facts.client_name || caseData.client_name || 'Client';
  const phoneNumberId = conversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = String(process.env.WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_NAME || '').trim();
  const languageCode = String(process.env.WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_LANGUAGE || 'en').trim();

  try {
    if (templateName) {
      await sendWhatsAppTemplate({
        to: conversation.from_number,
        phoneNumberId,
        templateName,
        languageCode,
        bodyParameters: [clientName]
      });
      return { sent: true, mode: 'template', template_name: templateName, language_code: languageCode };
    }

    await sendWhatsAppText({
      to: conversation.from_number,
      phoneNumberId,
      body: `Hi ${clientName}, your payment has been received. The VRS legal team will now prepare your letter for review. We will notify you once it has been completed.`
    });
    return { sent: true, mode: 'session_text' };
  } catch (error) {
    console.error('Payment confirmation WhatsApp notification failed:', error.message);
    return { sent: false, mode: templateName ? 'template_failed' : 'session_text_failed', error: error.message };
  }
}

async function unlockCaseIfPaid(payment, data, checks) {
  if (!supabase || !payment?.case_id) return { unlocked: false, reason: 'missing_case_id' };
  const isPaid = normaliseStatus(data.payment_status) === 'paid';

  // We require the transaction to match a payment we created and for PayFast
  // itself to validate the ITN. A local signature mismatch should not block a
  // legitimate payment when PayFast's server-side validation succeeds.
  const corePaymentChecksValid = checks.merchantValid === true &&
    checks.payfastValidationStatus === 'valid' &&
    checks.amountValid === true &&
    checks.paymentLinkValid === true;

  if (!isPaid) return { unlocked: false, reason: 'payment_not_complete' };
  if (!corePaymentChecksValid) return { unlocked: false, reason: 'verification_failed' };

  const { data: caseData, error } = await supabase
    .from('cases')
    .select('*')
    .eq('id', payment.case_id)
    .maybeSingle();
  if (error || !caseData) throw error || new Error('Case not found for paid transaction');

  if (caseData.payment_status === 'paid' && caseData.status === 'paid_ready_for_drafting') {
    return { unlocked: true, reason: 'already_unlocked' };
  }

  const paidAt = caseData.paid_at || new Date().toISOString();
  const facts = caseData.case_facts || {};
  const verificationMode = checks.signatureValid === true ? 'signature_and_server' : 'server_validated';

  const { error: updateError } = await supabase.from('cases').update({
    payment_status: 'paid',
    paid_at: paidAt,
    wp_generation_unlocked: true,
    status: 'paid_ready_for_drafting',
    letter_status: caseData.letter_status === 'sent' ? 'sent' : (caseData.letter_status || 'not_started'),
    case_facts: {
      ...facts,
      payment_status: 'paid',
      paid_at: paidAt,
      wp_generation_unlocked: true,
      payfast_payment_id: payment.pf_payment_id || data.pf_payment_id || null,
      payfast_m_payment_id: payment.m_payment_id || data.m_payment_id || null,
      payfast_verification_mode: verificationMode,
      payfast_signature_valid: checks.signatureValid === true,
      payfast_server_validation_status: checks.payfastValidationStatus
    },
    updated_at: new Date().toISOString()
  }).eq('id', payment.case_id);
  if (updateError) throw updateError;

  const notification = await notifyPaymentConfirmed(caseData);
  const notificationAt = notification.sent ? new Date().toISOString() : null;
  const { error: notificationUpdateError } = await supabase.from('cases').update({
    case_facts: {
      ...facts,
      payment_status: 'paid',
      paid_at: paidAt,
      wp_generation_unlocked: true,
      payfast_payment_id: payment.pf_payment_id || data.pf_payment_id || null,
      payfast_m_payment_id: payment.m_payment_id || data.m_payment_id || null,
      payfast_verification_mode: verificationMode,
      payfast_signature_valid: checks.signatureValid === true,
      payfast_server_validation_status: checks.payfastValidationStatus,
      payment_confirmation_notification: notification,
      payment_confirmation_notified_at: notificationAt
    },
    updated_at: new Date().toISOString()
  }).eq('id', payment.case_id);
  if (notificationUpdateError) throw notificationUpdateError;

  return { unlocked: true, reason: 'verified_payment', verificationMode, notification };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'Method Not Allowed' };
  }

  const rawBody = event.body || '';

  try {
    const data = parseFormBody(rawBody);
    const existingPayment = await getExistingPayment(data.m_payment_id || null);

    const signatureValid = verifyRawItnSignature(rawBody);
    const merchantValid = process.env.PAYFAST_MERCHANT_ID
      ? String(data.merchant_id || '') === String(process.env.PAYFAST_MERCHANT_ID)
      : false;
    const amountValid = Boolean(existingPayment) && amountsMatch(existingPayment.amount, data.amount_gross);
    const incomingCaseId = caseIdFrom(data);
    const paymentLinkValid = Boolean(existingPayment?.case_id) &&
      Boolean(incomingCaseId) &&
      String(existingPayment.case_id) === String(incomingCaseId);

    let payfastValidationStatus = 'not_checked';
    let payfastValidationResponse = null;

    // Always perform PayFast's own server-side ITN validation. This is the
    // authoritative fallback when our local signature reconstruction differs
    // from the exact payload PayFast used to generate its signature.
    try {
      const validation = await validateWithPayfast(rawBody);
      payfastValidationStatus = validation.ok ? 'valid' : 'invalid';
      payfastValidationResponse = validation.body;
    } catch (validationError) {
      payfastValidationStatus = 'error';
      payfastValidationResponse = validationError.message;
    }

    const checks = {
      signatureValid,
      merchantValid,
      amountValid,
      paymentLinkValid,
      payfastValidationStatus,
      payfastValidationResponse
    };

    const payment = await upsertPayment(data, checks);
    const unlockResult = await unlockCaseIfPaid(payment, data, checks);

    console.log('Payfast ITN received', {
      m_payment_id: data.m_payment_id,
      pf_payment_id: data.pf_payment_id,
      case_id: payment?.case_id,
      payment_status: data.payment_status,
      signatureValid,
      merchantValid,
      amountValid,
      paymentLinkValid,
      payfastValidationStatus,
      unlockResult
    });

    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'OK' };
  } catch (error) {
    console.error('Payfast ITN error:', error);
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'RECEIVED' };
  }
};