const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function authenticate(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Unauthorized: Missing Authentication Token');
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized: Invalid or expired token');
  return data.user;
}

function siteBaseUrl(event) {
  const configured = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = event.headers?.host;
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  throw new Error('Could not determine site URL for background function');
}

function internalSignature(rawBody) {
  if (!INTERNAL_SIGNING_KEY) {
    throw new Error('Internal letter-generation signing key is not configured');
  }
  return crypto.createHmac('sha256', INTERNAL_SIGNING_KEY).update(rawBody, 'utf8').digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!supabase) throw new Error('Supabase is not configured for letter generation');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

    await authenticate(event);

    const request = JSON.parse(event.body || '{}');
    if (!request.caseId) return json(400, { error: 'Case ID required' });

    const { data: caseData, error: caseError } = await supabase
      .from('cases')
      .select('case_facts,payment_status,paid_at,wp_generation_unlocked,letter_status')
      .eq('id', request.caseId)
      .single();
    if (caseError || !caseData) return json(404, { error: 'Case not found' });

    const facts = caseData.case_facts || {};
    const isPaid = caseData.payment_status === 'paid' || facts.payment_status === 'paid';
    const isUnlocked = caseData.wp_generation_unlocked === true || facts.wp_generation_unlocked === true;
    if (!isPaid || !isUnlocked) {
      return json(403, {
        error: 'Drafting is locked until PayFast confirms payment',
        payment_status: caseData.payment_status || facts.payment_status || 'unpaid'
      });
    }

    if (['generating', 'draft_ready', 'approved', 'sent'].includes(caseData.letter_status)) {
      return json(409, { error: `Letter drafting cannot start while letter status is ${caseData.letter_status}` });
    }

    const queuedAt = new Date().toISOString();
    const queuedFacts = {
      ...facts,
      wp_letter_status: 'QUEUED',
      wp_generation_queued_at: queuedAt,
      wp_generation_error: null
    };

    const { error: queueUpdateError } = await supabase.from('cases').update({
      status: 'drafting_in_progress',
      letter_status: 'generating',
      case_facts: queuedFacts,
      updated_at: queuedAt
    }).eq('id', request.caseId);
    if (queueUpdateError) throw new Error(`Could not mark letter generation as queued: ${queueUpdateError.message}`);

    const rawBody = JSON.stringify(request);
    const endpoint = `${siteBaseUrl(event)}/.netlify/functions/generate_letter-background`;
    const queued = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vrs-internal-signature': internalSignature(rawBody)
      },
      body: rawBody
    });

    if (!queued.ok) {
      const responseText = await queued.text();
      const { data: latest } = await supabase.from('cases').select('case_facts').eq('id', request.caseId).maybeSingle();
      const latestFacts = latest?.case_facts || queuedFacts;
      await supabase.from('cases').update({
        status: 'paid_ready_for_drafting',
        letter_status: 'generation_failed',
        case_facts: {
          ...latestFacts,
          wp_letter_status: 'QUEUE_FAILED',
          wp_generation_error: responseText.slice(0, 1000),
          wp_generation_failed_at: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
      }).eq('id', request.caseId);
      throw new Error(`Could not queue background drafting: ${queued.status} ${responseText.slice(0, 500)}`);
    }

    return json(202, {
      success: true,
      queued: true,
      caseId: request.caseId,
      message: 'Draft generation started. Refresh the case shortly to review the completed letter.'
    });
  } catch (error) {
    const message = String(error.message || 'Unknown error');
    const statusCode = message.startsWith('Unauthorized') ? 401 : 500;
    console.error('Draft Queue Error:', { message, stack: error.stack });
    return json(statusCode, { error: message });
  }
};
