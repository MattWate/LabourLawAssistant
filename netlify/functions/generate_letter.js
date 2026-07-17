const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function authenticate(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Unauthorized: Missing Authentication Token');
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized: Invalid or expired token');
  return authHeader;
}

function siteBaseUrl(event) {
  const configured = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = event.headers?.host;
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  throw new Error('Could not determine site URL for background function');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!supabase) throw new Error('Supabase is not configured for letter generation');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

    const authHeader = await authenticate(event);
    const request = JSON.parse(event.body || '{}');
    if (!request.caseId) return json(400, { error: 'Case ID required' });

    const { data: caseData, error: caseError } = await supabase
      .from('cases')
      .select('case_facts')
      .eq('id', request.caseId)
      .single();
    if (caseError || !caseData) return json(404, { error: 'Case not found' });

    const facts = caseData.case_facts || {};
    await supabase.from('cases').update({
      letter_status: 'generating',
      case_facts: {
        ...facts,
        wp_letter_status: 'QUEUED',
        wp_generation_queued_at: new Date().toISOString(),
        wp_generation_error: null
      },
      updated_at: new Date().toISOString()
    }).eq('id', request.caseId);

    const endpoint = `${siteBaseUrl(event)}/.netlify/functions/generate_letter-background`;
    const queued = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader
      },
      body: JSON.stringify(request)
    });

    if (!queued.ok) {
      const text = await queued.text();
      await supabase.from('cases').update({
        letter_status: 'generation_failed',
        case_facts: {
          ...facts,
          wp_letter_status: 'QUEUE_FAILED',
          wp_generation_error: text.slice(0, 1000),
          wp_generation_failed_at: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
      }).eq('id', request.caseId);
      throw new Error(`Could not queue background drafting: ${queued.status} ${text.slice(0, 500)}`);
    }

    return json(202, {
      success: true,
      queued: true,
      caseId: request.caseId,
      message: 'Draft generation started. Refresh the case shortly to review the completed letter.'
    });
  } catch (error) {
    const statusCode = String(error.message).startsWith('Unauthorized') ? 401 : 500;
    console.error('Draft Queue Error:', { message: error.message, stack: error.stack });
    return json(statusCode, { error: error.message });
  }
};