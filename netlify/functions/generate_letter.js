const { createClient } = require('@supabase/supabase-js');
const { handler: runLetterGeneration } = require('./generate_letter-background');

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

    await supabase.from('cases').update({
      status: 'drafting_in_progress',
      letter_status: 'generating',
      case_facts: {
        ...facts,
        wp_letter_status: 'QUEUED',
        wp_generation_queued_at: new Date().toISOString(),
        wp_generation_error: null
      },
      updated_at: new Date().toISOString()
    }).eq('id', request.caseId);

    // Run drafting in-process so generation no longer depends on a second
    // Netlify background-function HTTP invocation.
    const generationResult = await runLetterGeneration(event);
    const generationStatus = Number(generationResult?.statusCode || 500);

    let generationBody = {};
    try {
      generationBody = JSON.parse(generationResult?.body || '{}');
    } catch (e) {
      generationBody = {};
    }

    if (generationStatus < 200 || generationStatus >= 300) {
      const detail = generationBody.error || 'Letter generation failed';
      throw new Error(detail);
    }

    return json(200, {
      success: true,
      generated: true,
      caseId: request.caseId,
      message: 'Draft generation completed and is ready for review.'
    });
  } catch (error) {
    const message = String(error.message || 'Unknown error');
    const statusCode = message.startsWith('Unauthorized') ? 401 : 500;
    console.error('Draft Queue Error:', { message, stack: error.stack });
    return json(statusCode, { error: message });
  }
};