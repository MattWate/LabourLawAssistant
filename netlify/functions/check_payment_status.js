const { createClient } = require('@supabase/supabase-js');

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
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  try {
    const params = event.queryStringParameters || {};
    const caseId = params.caseId || params.case_id;
    const mPaymentId = params.m_payment_id;

    let query = supabase.from('payments').select('*').order('created_at', { ascending: false }).limit(1);
    if (mPaymentId) query = query.eq('m_payment_id', mPaymentId);
    else if (caseId) query = query.eq('case_id', caseId);
    else return json(400, { error: 'caseId or m_payment_id is required' });

    const { data, error } = await query.maybeSingle();
    if (error) throw error;

    return json(200, {
      success: true,
      found: Boolean(data),
      payment: data ? {
        id: data.id,
        case_id: data.case_id,
        m_payment_id: data.m_payment_id,
        pf_payment_id: data.pf_payment_id,
        amount: data.amount,
        item_name: data.item_name,
        status: data.status,
        signature_valid: data.signature_valid,
        merchant_valid: data.merchant_valid,
        payfast_validation_status: data.payfast_validation_status,
        received_at: data.received_at,
        updated_at: data.updated_at
      } : null
    });
  } catch (error) {
    console.error('check_payment_status error:', error);
    return json(500, { error: error.message });
  }
};