const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { CONSENT_CONFIG, mandateAcceptanceSnapshot, paymentConsentSnapshot } = require('./lib/consentConfig');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = URL && KEY ? createClient(URL, KEY) : null;

function json(statusCode, body) {
  return { statusCode, headers:{'Content-Type':'application/json','Cache-Control':'no-store, max-age=0'}, body:JSON.stringify(body) };
}
function sha256(v='') { return crypto.createHash('sha256').update(String(v),'utf8').digest('hex'); }

async function findCase(token) {
  if (!token || token.length < 32) return null;
  const hash = sha256(token);
  const { data, error } = await supabase
    .from('cases')
    .select('id,client_name,status,case_facts')
    .eq('case_facts->>client_consent_token_hash', hash)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function validate(caseData) {
  const f = caseData?.case_facts || {};
  const expires = f.client_consent_expires_at ? new Date(f.client_consent_expires_at).getTime() : 0;
  if (!expires || expires <= Date.now()) return { ok:false, status:410, error:'This consent link has expired. Please contact VRS for a new link.' };
  if (!['mandate','payment'].includes(f.client_consent_stage)) return { ok:false, status:409, error:'This consent request is no longer active.' };
  return { ok:true };
}

function payload(caseData) {
  const f = caseData.case_facts || {};
  const stage = f.client_consent_stage;
  return {
    case_reference: f.case_reference || caseData.id,
    client_name: f.client_name || caseData.client_name || 'Client',
    stage,
    expires_at: f.client_consent_expires_at,
    heading: stage === 'mandate' ? 'Accept the VRS mandate' : 'Confirm instruction to start work after payment',
    text: stage === 'mandate' ? CONSENT_CONFIG.mandate.text : CONSENT_CONFIG.pre_payment.text,
    checkbox_label: stage === 'mandate'
      ? 'I have read and accept the VRS Labour Law Consultants mandate.'
      : 'I confirm that VRS may start work as soon as I pay and I accept the pre-payment wording above.'
  };
}

exports.handler = async (event) => {
  try {
    if (!supabase) throw new Error('Supabase is not configured');
    const token = event.queryStringParameters?.token || '';
    const caseData = await findCase(token);
    if (!caseData) return json(404,{error:'Consent link not found.'});
    const validation = validate(caseData);
    if (!validation.ok) return json(validation.status,{error:validation.error});

    if (event.httpMethod === 'GET') return json(200,payload(caseData));
    if (event.httpMethod !== 'POST') return json(405,{error:'Method Not Allowed'});

    const body = JSON.parse(event.body || '{}');
    if (body.action !== 'accept') return json(400,{error:'Choose accept to continue.'});

    const facts = caseData.case_facts || {};
    const now = new Date().toISOString();

    if (facts.client_consent_stage === 'mandate') {
      const updated = {
        ...facts,
        mandate_acceptance: mandateAcceptanceSnapshot('email'),
        mandate_accepted_via_email_at: now,
        client_consent_stage: 'payment',
        client_consent_stage_changed_at: now
      };
      const { error } = await supabase.from('cases').update({
        status:'awaiting_payment_consent',
        case_facts:updated,
        updated_at:now
      }).eq('id',caseData.id);
      if (error) throw error;
      return json(200,{
        success:true,
        next_stage:'payment',
        message:'Your mandate acceptance has been recorded. Please confirm the instruction to start work after payment.',
        ...payload({ ...caseData, case_facts:updated })
      });
    }

    const updated = {
      ...facts,
      payment_start_consent: paymentConsentSnapshot('email'),
      payment_consent_accepted_via_email_at: now,
      client_consent_stage:null,
      client_consent_token_hash:null,
      client_consent_expires_at:null,
      client_consent_completed_at:now
    };
    const { error } = await supabase.from('cases').update({
      status:'approved_for_payment',
      case_facts:updated,
      updated_at:now
    }).eq('id',caseData.id);
    if (error) throw error;
    return json(200,{
      success:true,
      completed:true,
      message:'Thank you. Both required consents have been recorded. VRS can now issue your payment request.'
    });
  } catch(error) {
    console.error('client case consent error:', error);
    return json(500,{error:'The consent request could not be processed. Please contact VRS.'});
  }
};
