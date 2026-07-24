const { createClient } = require('@supabase/supabase-js');
const { getPayfastBaseUrl, amountToPayfast, generatePaymentId, buildCheckoutFields, fieldsToQuery } = require('./lib/payfast');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

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

function firstAndLast(name = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name_first: parts[0] || 'Client',
    name_last: parts.slice(1).join(' ') || 'VRS'
  };
}

function emailFrom(contact = '') {
  const found = String(contact || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return found ? found[0] : (process.env.PAYFAST_FALLBACK_EMAIL || 'payments@example.com');
}

function wpEligible(facts = {}) {
  return facts.wp_eligible === true || facts.effective_decision?.wp_eligible === true || facts.admin_override?.wp_eligible === true;
}

function isMissingColumn(error) {
  const message = String(error?.message || '');
  return error?.code === 'PGRST204' || /could not find the .* column/i.test(message);
}

async function insertPayment(payload) {
  let result = await supabase.from('payments').insert(payload).select().single();
  if (!result.error) return result;

  if (!isMissingColumn(result.error)) return result;

  // Older production schemas may not yet contain the checkout metadata columns.
  const legacyPayload = {
    case_id: payload.case_id,
    provider: payload.provider,
    m_payment_id: payload.m_payment_id,
    amount: payload.amount,
    item_name: payload.item_name,
    status: payload.status
  };

  result = await supabase.from('payments').insert(legacyPayload).select().single();
  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const caseId = body.caseId || body.case_id;
    if (!caseId) return json(400, { error: 'caseId is required' });

    const { data: caseData, error } = await supabase
      .from('cases')
      .select('id, client_name, contact_info, case_facts')
      .eq('id', caseId)
      .single();
    if (error || !caseData) return json(404, { error: 'Case not found' });

    const facts = caseData.case_facts || {};
    if (!wpEligible(facts)) return json(400, { error: 'Case is not WP eligible' });

    const site = String(process.env.PUBLIC_SITE_URL || 'https://labourlawassist.netlify.app').replace(/\/$/, '');
    const amount = amountToPayfast(body.amount || process.env.PAYFAST_WP_LETTER_AMOUNT || '950.00');
    const itemName = body.item_name || process.env.PAYFAST_WP_ITEM_NAME || 'VRS WP Letter Review';
    const mPaymentId = generatePaymentId(caseId);
    const names = firstAndLast(facts.client_name || caseData.client_name);

    const fields = buildCheckoutFields({
      merchant_id: process.env.PAYFAST_MERCHANT_ID,
      merchant_key: process.env.PAYFAST_MERCHANT_KEY,
      return_url: process.env.PAYFAST_RETURN_URL || `${site}/payment-success.html?caseId=${encodeURIComponent(caseId)}`,
      cancel_url: process.env.PAYFAST_CANCEL_URL || `${site}/payment-cancelled.html?caseId=${encodeURIComponent(caseId)}`,
      notify_url: process.env.PAYFAST_NOTIFY_URL || `${site}/.netlify/functions/payfast_itn`,
      name_first: names.name_first,
      name_last: names.name_last,
      email_address: emailFrom(facts.contact_info || caseData.contact_info),
      m_payment_id: mPaymentId,
      amount,
      item_name: itemName,
      item_description: `Case ${caseId}`,
      custom_str1: caseId
    });

    const checkoutBaseUrl = getPayfastBaseUrl();
    const { data: payment, error: payErr } = await insertPayment({
      case_id: caseId,
      provider: 'payfast',
      m_payment_id: mPaymentId,
      amount,
      item_name: itemName,
      status: 'pending',
      checkout_url: checkoutBaseUrl,
      checkout_fields: fields,
      updated_at: new Date().toISOString()
    });
    if (payErr) throw payErr;

    await supabase.from('cases').update({ payment_status: 'pending', status: 'payment_pending', updated_at: new Date().toISOString() }).eq('id', caseId);

    return json(200, {
      success: true,
      payment_id: payment.id,
      m_payment_id: mPaymentId,
      payment_url: `${checkoutBaseUrl}?${fieldsToQuery(fields)}`,
      fields,
      amount,
      item_name: itemName
    });
  } catch (error) {
    console.error('create_payfast_payment error:', error);
    return json(500, { error: error.message });
  }
};
