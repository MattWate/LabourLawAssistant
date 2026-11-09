const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { FIXTURES } = require('./lib/liveDraftingFixtures');
const { buildCaseBrief } = require('./lib/claudeDrafting');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

async function authenticate(event) {
  if (!supabase) throw new Error('Supabase is not configured');
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Unauthorized');
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized');
  return data.user;
}

function siteBaseUrl(event) {
  const host = event.headers?.host || event.headers?.['x-forwarded-host'];
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  const configured = process.env.DEPLOY_PRIME_URL || process.env.URL;
  if (configured) return configured.replace(/\/$/, '');
  throw new Error('Could not determine site URL');
}

function sign(rawBody) {
  if (!INTERNAL_SIGNING_KEY) throw new Error('Internal drafting signing key is not configured');
  return crypto.createHmac('sha256', INTERNAL_SIGNING_KEY).update(rawBody, 'utf8').digest('hex');
}

function fixtureFacts(key, customFacts) {
  if (key === 'custom') {
    if (!customFacts || typeof customFacts !== 'object' || Array.isArray(customFacts)) {
      throw new Error('Custom test requires a facts object');
    }
    return { label: 'Custom facts', facts: customFacts };
  }
  const fixture = FIXTURES[key];
  if (!fixture) throw new Error('Unknown test fixture');
  return { label: fixture.name, facts: fixture.facts };
}

async function loadHarnessCase(caseId) {
  const { data, error } = await supabase
    .from('cases')
    .select('id,client_name,status,letter_status,draft_letter,case_facts,payment_status,wp_generation_unlocked,created_at,updated_at')
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const user = await authenticate(event);
    const requestedBy = user.email || user.id;
    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || 'start');

    if (action === 'status') {
      const caseId = String(body.caseId || '');
      if (!caseId) return json(400, { error: 'caseId required' });

      const row = await loadHarnessCase(caseId);
      if (!row) return json(404, { error: 'Harness test case not found' });

      const facts = row.case_facts || {};
      if (facts.harness_test !== true || facts.harness_requested_by !== requestedBy) {
        return json(403, { error: 'Forbidden' });
      }

      const failed = row.letter_status === 'generation_failed' || ['GENERATION_FAILED','QUALITY_REVIEW_FAILED','QUEUE_FAILED'].includes(facts.wp_letter_status);
      const completed = row.letter_status === 'pending_review' && Boolean(row.draft_letter);

      if (failed) {
        const sourceFacts = facts.harness_source_facts || {};
        return json(200, {
          status: 'failed',
          caseId,
          stage: facts.wp_letter_status || row.letter_status,
          error: facts.wp_generation_error || 'Drafting failed',
          case_status: row.status,
          letter_status: row.letter_status,
          fixture: facts.harness_fixture || 'custom',
          label: facts.harness_label || 'Harness case',
          source_facts: sourceFacts,
          case_brief: buildCaseBrief({ facts: sourceFacts, senderVariant: 'VRS', clientSide: 'employee' }),
          letter: facts.wp_failed_draft_preview || '',
          structure: facts.wp_letter_structure || null,
          supervisory_assessment: facts.wp_supervisory_assessment || null,
          run_summary: {
            drafting_quality_score: facts.wp_supervisory_assessment?.drafting_quality_score ?? null,
            quality_floor_met: false,
            redraft_performed: facts.wp_supervisory_assessment?.redraft_performed ?? false,
            initial_drafting_quality_score: facts.wp_supervisory_assessment?.initial_drafting_quality_score ?? null,
            final_drafting_quality_score: facts.wp_supervisory_assessment?.final_drafting_quality_score ?? null,
            mandatory_drafting_defects: facts.wp_supervisory_assessment?.mandatory_drafting_defects || []
          },
          skill_hash: facts.wp_skill_hash || null,
          skill_manifest: facts.wp_skill_manifest || null,
          llm_call_logs: facts.llm_call_logs || []
        });
      }

      if (!completed) {
        return json(200, {
          status: 'running',
          caseId,
          stage: facts.wp_letter_status || row.letter_status || row.status,
          case_status: row.status,
          letter_status: row.letter_status,
          updated_at: row.updated_at
        });
      }

      const sourceFacts = facts.harness_source_facts || {};
      return json(200, {
        status: 'completed',
        harness: 'production-background-drafting',
        caseId,
        fixture: facts.harness_fixture || 'custom',
        label: facts.harness_label || 'Harness case',
        generated_at: facts.wp_generation_completed_at || row.updated_at,
        run_by: requestedBy,
        source_facts: sourceFacts,
        case_brief: buildCaseBrief({ facts: sourceFacts, senderVariant: 'VRS', clientSide: 'employee' }),
        letter: row.draft_letter,
        structure: facts.wp_letter_structure || null,
        supervisory_assessment: facts.wp_supervisory_assessment || null,
        run_summary: {
          drafting_quality_score: facts.wp_supervisory_assessment?.drafting_quality_score ?? null,
          quality_floor_met: facts.wp_supervisory_assessment?.quality_floor_met ?? null,
          redraft_performed: facts.wp_supervisory_assessment?.redraft_performed ?? false,
          initial_drafting_quality_score: facts.wp_supervisory_assessment?.initial_drafting_quality_score ?? null,
          final_drafting_quality_score: facts.wp_supervisory_assessment?.final_drafting_quality_score ?? null
        },
        skill_hash: facts.wp_skill_hash || null,
        skill_manifest: facts.wp_skill_manifest || null,
        llm_call_logs: facts.llm_call_logs || []
      });
    }

    if (action === 'delete') {
      const caseId = String(body.caseId || '');
      if (!caseId) return json(400, { error: 'caseId required' });
      const row = await loadHarnessCase(caseId);
      if (!row) return json(200, { success: true, already_deleted: true });
      const facts = row.case_facts || {};
      if (facts.harness_test !== true || facts.harness_requested_by !== requestedBy) {
        return json(403, { error: 'Forbidden' });
      }
      const { error } = await supabase.from('cases').delete().eq('id', caseId);
      if (error) throw error;
      return json(200, { success: true });
    }

    const fixture = String(body.fixture || '').trim();
    const selected = fixtureFacts(fixture, body.facts);
    const now = new Date().toISOString();

    const testFacts = {
      ...selected.facts,
      wp_eligible: true,
      payment_status: 'paid',
      wp_generation_unlocked: true,
      hard_disqualifier: false,
      harness_test: true,
      harness_fixture: fixture,
      harness_label: selected.label,
      harness_requested_by: requestedBy,
      harness_created_at: now,
      harness_source_facts: selected.facts,
      wp_letter_status: 'HARNESS_QUEUED'
    };

    const { data: inserted, error: insertError } = await supabase.from('cases').insert({
      client_name: '[HARNESS] ' + (selected.facts.client_name || selected.label),
      contact_info: 'temporary-drafting-harness',
      issue_summary: '[TEMPORARY QA] ' + (selected.facts.incident_description || selected.label),
      case_facts: testFacts,
      status: 'paid_ready_for_drafting',
      letter_status: 'not_drafted',
      payment_status: 'paid',
      paid_at: now,
      wp_generation_unlocked: true
    }).select('id').single();

    if (insertError) throw new Error('Could not create temporary harness case: ' + insertError.message);

    const caseId = inserted.id;
    const rawBody = JSON.stringify({ caseId, sender_variant: 'VRS', client_side: 'employee' });
    const endpoint = `${siteBaseUrl(event)}/.netlify/functions/generate_letter-background`;
    const queued = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vrs-internal-signature': sign(rawBody)
      },
      body: rawBody
    });

    if (!queued.ok && queued.status !== 202) {
      const responseText = await queued.text();
      await supabase.from('cases').update({
        status: 'harness_failed',
        letter_status: 'generation_failed',
        case_facts: {
          ...testFacts,
          wp_letter_status: 'HARNESS_QUEUE_FAILED',
          wp_generation_error: `${queued.status} ${responseText.slice(0, 500)}`
        }
      }).eq('id', caseId);
      return json(500, {
        error: 'Production background function could not be queued',
        caseId,
        http_status: queued.status,
        detail: responseText.slice(0, 500)
      });
    }

    return json(202, { success: true, caseId, status: 'queued', fixture, label: selected.label });
  } catch (error) {
    const message = String(error.message || 'Unknown error');
    return json(message === 'Unauthorized' ? 401 : 500, { error: message });
  }
};