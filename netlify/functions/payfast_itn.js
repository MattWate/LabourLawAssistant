const { createClient } = require('@supabase/supabase-js');
const { parseFormBody, verifySignature, validateWithPayfast } = require('./lib/payfast');

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

  const { data: existing } = await supabase
    .from('payments')
    .select('id, case_id')
    .eq('m_payment_id', mPaymentId)
    .maybeSingle();

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

async function unlockCaseIfPaid(payment, data, checks) {
  if (!supabase || !payment?.case_id) return;
  const isPaid = normaliseStatus(data.payment_status) === 'paid';
  const isVerified = checks.signatureValid === true && checks.merchantValid === true;
  if (!isPaid || !isVerified) return;

  const { data: existing } = await supabase
    .from('cases')
    .select('case_facts')
    .eq('id', payment.case_id)
    .maybeSingle();

  const facts = existing?.case_facts || {};

  await supabase
    .from('cases')
    .update({
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      wp_generation_unlocked: true,
      status: 'paid_pending_draft',
      case_facts: {
        ...facts,
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        wp_generation_unlocked: true,
        payfast_payment_id: payment.pf_payment_id || data.pf_payment_id || null,
        payfast_m_payment_id: payment.m_payment_id || data.m_payment_id || null
      },
      updated_at: new Date().toISOString()
    })
    .eq('id', payment.case_id);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'Method Not Allowed' };
  }

  const rawBody = event.body || '';

  try {
    const data = parseFormBody(rawBody);
    const signatureValid = verifySignature(data);
    const merchantValid = process.env.PAYFAST_MERCHANT_ID
      ? String(data.merchant_id || '') === String(process.env.PAYFAST_MERCHANT_ID)
      : null;

    let payfastValidationStatus = 'not_checked';
    let payfastValidationResponse = null;

    if (signatureValid) {
      try {
        const validation = await validateWithPayfast(rawBody);
        payfastValidationStatus = validation.ok ? 'valid' : 'invalid';
        payfastValidationResponse = validation.body;
      } catch (validationError) {
        payfastValidationStatus = 'error';
        payfastValidationResponse = validationError.message;
      }
    }

    const checks = { signatureValid, merchantValid, payfastValidationStatus, payfastValidationResponse };
    const payment = await upsertPayment(data, checks);
    await unlockCaseIfPaid(payment, data, checks);

    console.log('Payfast ITN received', {
      m_payment_id: data.m_payment_id,
      pf_payment_id: data.pf_payment_id,
      case_id: payment?.case_id,
      payment_status: data.payment_status,
      signatureValid,
      merchantValid,
      payfastValidationStatus
    });

    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'OK' };
  } catch (error) {
    console.error('Payfast ITN error:', error);
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'RECEIVED' };
  }
};