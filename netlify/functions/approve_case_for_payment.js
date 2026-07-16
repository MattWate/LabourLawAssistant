const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppText } = require('./lib/whatsapp');

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

    const facts = caseData.case_facts || {};
    const employerEmail = extractEmail(facts.employer_contact_details);
    const clientEmail = facts.client_email || extractEmail(facts.contact_info || caseData.contact_info);

    if (!clientEmail) return json(400, { error: 'Client email is missing from the case' });
    if (!employerEmail) return json(400, { error: 'Employer email is missing from the case' });

    const approvedFacts = {
      ...facts,
      wp_eligible: true,
      lawyer_approved: true,
      lawyer_approved_at: new Date().toISOString(),
      lawyer_approved_by: lawyer.email || lawyer.id,
      client_email: clientEmail,
      employer_email: employerEmail
    };

    await supabase.from('cases').update({
      case_facts: approvedFacts,
      status: 'approved_for_payment',
      letter_status: caseData.letter_status || 'not_started',
      updated_at: new Date().toISOString()
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

    if (conversation?.from_number) {
      await sendWhatsAppText({
        to: conversation.from_number,
        phoneNumberId: conversation.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
        body: `A VRS lawyer has reviewed your matter and confirmed that it is eligible to proceed to a formal letter. Please use the secure payment link below. Once payment is confirmed, the approved letter will be sent to your employer and copied to you.\n\n${payment.payment_url}`
      });
    }

    return json(200, {
      success: true,
      case_id: caseId,
      payment_url: payment.payment_url,
      client_email: clientEmail,
      employer_email: employerEmail,
      whatsapp_sent: Boolean(conversation?.from_number)
    });
  } catch (error) {
    const status = error.message === 'Unauthorized' ? 401 : 500;
    console.error('approve_case_for_payment error:', error);
    return json(status, { error: error.message });
  }
};