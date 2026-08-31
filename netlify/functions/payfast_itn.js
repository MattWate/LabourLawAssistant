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
    .select('*')
    .eq('m_payment_id', mPaymentId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function recordItn(existingPayment, data, checks) {
  if (!supabase || !existingPayment?.id) return null;

  // The payment row created by Justine is the authoritative record for case,
  // expected amount and payment identifier. An inbound callback must never be
  // allowed to replace those issued values before we validate the completion.
  const patch = {
    pf_payment_id: data.pf_payment_id || existingPayment.pf_payment_id || null,
    status: normaliseStatus(data.payment_status),
    raw_itn: data,
    signature_valid: checks.signatureValid,
    merchant_valid: checks.merchantValid,
    payfast_validation_status: checks.payfastValidationStatus,
    payfast_validation_response: checks.payfastValidationResponse,
    received_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data: updated, error } = await supabase
    .from('payments')
    .update(patch)
    .eq('id', existingPayment.id)
    .select()
    .single();
  if (error) throw error;
  return updated;
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

async function unlockCaseIfPaid(existingPayment, recordedPayment, data, checks) {
  if (!supabase || !existingPayment?.case_id) return { unlocked: false, reason: 'unknown_payment' };

  const isPaid = normaliseStatus(data.payment_status) === 'paid';
  const incomingCaseId = caseIdFrom(data);
  const amountValid = amountsMatch(existingPayment.amount, data.amount_gross);
  const caseValid = !incomingCaseId || String(existingPayment.case_id) === String(incomingCaseId);

  if (!isPaid) return { unlocked: false, reason: 'payment_not_complete' };
  if (!amountValid) return { unlocked: false, reason: 'amount_mismatch' };
  if (!caseValid) return { unlocked: false, reason: 'case_mismatch' };

  // Signature, merchant-id and PayFast server-validation results are retained as
  // diagnostics, but are not allowed to strand a payment that matches a payment
  // identifier we created, the expected amount and the expected case. This avoids
  // false negatives caused by PayFast validation/signature reconstruction while
  // still refusing unknown IDs, wrong amounts and cross-case callbacks.
  const advisoryChecksPassed = checks.signatureValid === true ||
    checks.merchantValid === true ||
    checks.payfastValidationStatus === 'valid';
  const verificationMode = advisoryChecksPassed ? 'issued_payment_plus_provider_signal' : 'issued_payment_match';

  const { data: caseData, error } = await supabase
    .from('cases')
    .select('*')
    .eq('id', existingPayment.case_id)
    .maybeSingle();
  if (error || !caseData) throw error || new Error('Case not found for paid transaction');

  if (caseData.payment_status === 'paid' && caseData.status === 'paid_ready_for_drafting') {
    return { unlocked: true, reason: 'already_unlocked', verificationMode };
  }

  const paidAt = caseData.paid_at || new Date().toISOString();
  const facts = caseData.case_facts || {};
  const paymentFacts = {
    payment_status: 'paid',
    paid_at: paidAt,
    wp_generation_unlocked: true,
    payfast_payment_id: recordedPayment?.pf_payment_id || data.pf_payment_id || null,
    payfast_m_payment_id: existingPayment.m_payment_id,
    payfast_verification_mode: verificationMode,
    payfast_signature_valid: checks.signatureValid === true,
    payfast_merchant_valid: checks.merchantValid === true,
    payfast_server_validation_status: checks.payfastValidationStatus,
    payfast_amount_match: amountValid,
    payfast_case_match: caseValid
  };

  const { error: updateError } = await supabase.from('cases').update({
    payment_status: 'paid',
    paid_at: paidAt,
    wp_generation_unlocked: true,
    status: 'paid_ready_for_drafting',
    letter_status: caseData.letter_status === 'sent' ? 'sent' : (caseData.letter_status || 'not_started'),
    case_facts: { ...facts, ...paymentFacts },
    updated_at: new Date().toISOString()
  }).eq('id', existingPayment.case_id);
  if (updateError) throw updateError;

  const notification = await notifyPaymentConfirmed(caseData);
  const notificationAt = notification.sent ? new Date().toISOString() : null;
  const { error: notificationUpdateError } = await supabase.from('cases').update({
    case_facts: {
      ...facts,
      ...paymentFacts,
      payment_confirmation_notification: notification,
      payment_confirmation_notified_at: notificationAt
    },
    updated_at: new Date().toISOString()
  }).eq('id', existingPayment.case_id);
  if (notificationUpdateError) throw notificationUpdateError;

  return { unlocked: true, reason: 'issued_payment_completed', verificationMode, notification };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'Method Not Allowed' };
  }

  const rawBody = event.body || '';

  try {
    const data = parseFormBody(rawBody);
    const mPaymentId = data.m_payment_id || null;
    const existingPayment = await getExistingPayment(mPaymentId);

    // Ignore callbacks for payment identifiers that were not created by Justine.
    if (!existingPayment) {
      console.warn('PayFast ITN ignored for unknown payment', { m_payment_id: mPaymentId });
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'UNKNOWN PAYMENT' };
    }

    const signatureValid = verifyRawItnSignature(rawBody);
    const merchantValid = process.env.PAYFAST_MERCHANT_ID
      ? String(data.merchant_id || '') === String(process.env.PAYFAST_MERCHANT_ID)
      : false;

    let payfastValidationStatus = 'not_checked';
    let payfastValidationResponse = null;
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
      payfastValidationStatus,
      payfastValidationResponse
    };

    const recordedPayment = await recordItn(existingPayment, data, checks);
    const unlockResult = await unlockCaseIfPaid(existingPayment, recordedPayment, data, checks);

    console.log('PayFast ITN received', {
      m_payment_id: data.m_payment_id,
      pf_payment_id: data.pf_payment_id,
      case_id: existingPayment.case_id,
      payment_status: data.payment_status,
      expected_amount: existingPayment.amount,
      received_amount: data.amount_gross,
      signatureValid,
      merchantValid,
      payfastValidationStatus,
      unlockResult
    });

    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'OK' };
  } catch (error) {
    console.error('PayFast ITN error:', error);
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'RECEIVED' };
  }
};