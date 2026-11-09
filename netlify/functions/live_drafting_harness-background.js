const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getStore } = require('@netlify/blobs');
const { loadWpSkillSet, buildProtectedPromptContext } = require('./lib/skillRegistry');
const { buildCaseBrief, callClaudeForWpDraft } = require('./lib/claudeDrafting');
const { normaliseLetterStructure, letterStructureToPlainText } = require('./lib/letterStructure');
const { FIXTURES } = require('./lib/liveDraftingFixtures');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const STORE_NAME = 'justine-drafting-harness';

function verifySignature(event, raw) {
  if (!INTERNAL_SIGNING_KEY) throw new Error('Harness signing key is not configured');
  const supplied = String(event.headers?.['x-vrs-internal-signature'] || event.headers?.['X-VRS-Internal-Signature'] || '');
  if (!supplied) throw new Error('Unauthorized');
  const expected = crypto.createHmac('sha256', INTERNAL_SIGNING_KEY).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Unauthorized');
}

function store() {
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  const raw = event.body || '{}';
  let jobId = null;
  let requestedBy = null;

  try {
    verifySignature(event, raw);
    const request = JSON.parse(raw);
    jobId = request.jobId;
    requestedBy = request.requested_by;
    if (!jobId) throw new Error('jobId required');
    if (!supabase) throw new Error('Supabase is not configured');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

    await store().setJSON(jobId, {
      harness: 'live_drafting_harness',
      jobId,
      status: 'running',
      fixture: request.fixture,
      requested_by: requestedBy,
      started_at: new Date().toISOString()
    });

    let facts;
    let label;
    if (request.fixture === 'custom') {
      if (!request.facts || typeof request.facts !== 'object' || Array.isArray(request.facts)) {
        throw new Error('Custom test requires a facts object');
      }
      facts = request.facts;
      label = 'Custom facts';
    } else {
      const fixture = FIXTURES[request.fixture];
      if (!fixture) throw new Error('Unknown test fixture');
      facts = fixture.facts;
      label = fixture.name;
    }

    const skillSet = await loadWpSkillSet(supabase, { side: 'employee' });
    const skillContext = buildProtectedPromptContext(skillSet);
    const caseBrief = buildCaseBrief({ facts, senderVariant: 'VRS', clientSide: 'employee' });
    const startedAt = new Date().toISOString();
    const output = await callClaudeForWpDraft({ skillContext, caseBrief, skillSet });
    const structure = normaliseLetterStructure(output.draft.part_a_letter || {});
    const letter = letterStructureToPlainText(structure);

    await store().setJSON(jobId, {
      harness: 'live_drafting_harness',
      jobId,
      status: 'completed',
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      requested_by: requestedBy,
      fixture: request.fixture,
      label,
      skill_hash: skillSet.skill_hash,
      skill_manifest: skillSet.manifest,
      model: output.log?.model || null,
      case_brief: caseBrief,
      letter,
      structure,
      supervisory_assessment: output.draft.part_b_supervisory_assessment || {},
      run_summary: {
        quality_floor_met: output.log?.quality_floor_met ?? null,
        drafting_quality_score: output.log?.drafting_quality_score ?? null,
        redraft_performed: output.log?.redraft_performed ?? false,
        calls: output.log?.calls || []
      }
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, jobId }) };
  } catch (error) {
    if (jobId) {
      await store().setJSON(jobId, {
        harness: 'live_drafting_harness',
        jobId,
        status: 'failed',
        requested_by: requestedBy,
        completed_at: new Date().toISOString(),
        error: String(error.message || error)
      });
    }
    return {
      statusCode: String(error.message || '').startsWith('Unauthorized') ? 401 : 500,
      body: JSON.stringify({ error: String(error.message || error), jobId })
    };
  }
};