const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function stagingOnly() {
  const context = String(process.env.CONTEXT || '').toLowerCase();
  const branch = String(process.env.BRANCH || process.env.HEAD || '').toLowerCase();
  return context !== 'production' && branch !== 'main';
}

async function authenticate(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Unauthorized: Missing Authentication Token');
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await authClient.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized: Invalid or expired token');
  return data.user;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!stagingOnly()) return json(404, { error: 'Not Found' });

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Supabase is not configured');
    const user = await authenticate(event);
    const body = JSON.parse(event.body || '{}');
    const sourceCaseId = body.sourceCaseId;
    if (!sourceCaseId) return json(400, { error: 'sourceCaseId is required' });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: source, error: sourceError } = await admin
      .from('cases')
      .select('*')
      .eq('id', sourceCaseId)
      .single();

    if (sourceError || !source) return json(404, { error: 'Source case not found' });
    const sourceFacts = source.case_facts || {};
    const wpEligible = sourceFacts.wp_eligible === true ||
      sourceFacts.effective_decision?.wp_eligible === true ||
      sourceFacts.admin_override?.wp_eligible === true;
    if (!wpEligible) return json(409, { error: 'Choose a WP-eligible source case for drafting regression testing.' });

    const now = new Date().toISOString();
    const testFacts = {
      ...sourceFacts,
      wants_letter: true,
      payment_status: 'paid',
      wp_generation_unlocked: true,
      wp_letter_status: 'NOT_DRAFTED',
      drafting_test: {
        staging_only: true,
        source_case_id: sourceCaseId,
        prepared_at: now,
        prepared_by: user.email || user.id
      }
    };

    delete testFacts.wp_generation_error;
    delete testFacts.wp_generation_started_at;
    delete testFacts.wp_generation_completed_at;
    delete testFacts.wp_background_started_at;
    delete testFacts.wp_generation_claude_started_at;
    delete testFacts.wp_generation_claude_completed_at;
    delete testFacts.wp_letter_structure;
    delete testFacts.wp_supervisory_assessment;
    delete testFacts.approved_text_hash;
    delete testFacts.letter_document_path;
    delete testFacts.letter_document_filename;
    delete testFacts.letter_document_generated_at;
    delete testFacts.letter_approved_at;
    delete testFacts.letter_approved_by;

    const payload = {
      client_name: source.client_name || sourceFacts.client_name || 'Drafting Regression Test',
      contact_info: source.contact_info || sourceFacts.contact_info || null,
      issue_summary: '[STAGING DRAFT TEST] ' + (source.issue_summary || 'WP drafting regression case'),
      case_facts: testFacts,
      status: 'paid_ready_for_drafting',
      payment_status: 'paid',
      paid_at: now,
      wp_generation_unlocked: true,
      letter_status: 'not_drafted',
      draft_letter: null
    };

    const { data: created, error: insertError } = await admin
      .from('cases')
      .insert(payload)
      .select()
      .single();
    if (insertError) throw insertError;

    return json(200, {
      success: true,
      case: created,
      source_case_id: sourceCaseId,
      prepared_by: user.email || user.id
    });
  } catch (error) {
    const message = String(error.message || error);
    return json(message.startsWith('Unauthorized') ? 401 : 500, { error: message });
  }
};
