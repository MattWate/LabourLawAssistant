const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const ALLOWED = new Set(['refund_required','refund_processed','credit_offered','credit_issued']);

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function authenticate(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('Unauthorized');
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized');
  return data.user;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!supabase) throw new Error('Supabase is not configured');
    const user = await authenticate(event);
    const body = JSON.parse(event.body || '{}');
    const caseId = body.caseId || body.case_id;
    const resolution = String(body.resolution || '').trim().toLowerCase();

    if (!caseId) return json(400, { error: 'caseId is required' });
    if (!ALLOWED.has(resolution)) return json(400, { error: 'Invalid refund/credit resolution' });

    const { data: caseData, error } = await supabase.from('cases').select('*').eq('id', caseId).single();
    if (error || !caseData) return json(404, { error: 'Case not found' });
    if (caseData.payment_status !== 'paid') return json(409, { error: 'Refund or credit can only be recorded for a paid case' });

    const now = new Date().toISOString();
    const facts = caseData.case_facts || {};
    const history = Array.isArray(facts.payment_resolution_history) ? facts.payment_resolution_history : [];
    const eventRecord = {
      resolution,
      recorded_at: now,
      recorded_by: user.email || user.id,
      amount: body.amount ?? facts.payment_amount ?? null,
      note: String(body.note || '').trim() || null
    };

    const updatedFacts = {
      ...facts,
      payment_resolution: eventRecord,
      payment_resolution_history: [...history, eventRecord]
    };

    const statusMap = {
      refund_required: 'paid_refund_required',
      refund_processed: 'paid_refunded',
      credit_offered: 'paid_credit_offered',
      credit_issued: 'paid_credited'
    };

    const { error: updateError } = await supabase.from('cases').update({
      case_facts: updatedFacts,
      status: statusMap[resolution],
      updated_at: now
    }).eq('id', caseId);
    if (updateError) throw updateError;

    return json(200, { success: true, resolution: eventRecord, status: statusMap[resolution] });
  } catch (error) {
    const status = String(error.message || '') === 'Unauthorized' ? 401 : 500;
    console.error('manage_payment_resolution error:', error.message);
    return json(status, { error: error.message });
  }
};
