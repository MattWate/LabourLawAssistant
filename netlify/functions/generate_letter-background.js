const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { loadWpSkillSet, buildProtectedPromptContext } = require('./lib/skillRegistry');
const { buildCaseBrief, callClaudeForWpDraft } = require('./lib/claudeDrafting');
const { normaliseLetterStructure, letterStructureToPlainText } = require('./lib/letterStructure');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function canGenerateWpLetter(facts = {}) {
  const eligible = facts.wp_eligible === true || facts.effective_decision?.wp_eligible === true || facts.admin_override?.wp_eligible === true;
  return eligible && !facts.hard_disqualifier;
}

function blockedReason(facts = {}) {
  if (facts.hard_disqualifier) return 'The case has a hard disqualifier and cannot generate a Without Prejudice letter until reviewed.';
  return 'The effective firm decision does not currently mark this case as WP eligible.';
}

function normaliseSenderVariant(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return ['client', 'client_sent', 'client-sent', 'own_name', 'own-name', 'self'].includes(text) ? 'CLIENT_SENT' : 'VRS';
}

function normaliseClientSide(value = '') {
  return String(value || '').trim().toLowerCase() === 'employer' ? 'employer' : 'employee';
}

function verifyInternalSignature(event, rawBody) {
  if (!INTERNAL_SIGNING_KEY) throw new Error('Unauthorized: Internal letter-generation signing key is not configured');
  const supplied = String(event.headers?.['x-vrs-internal-signature'] || event.headers?.['X-VRS-Internal-Signature'] || '');
  if (!supplied) throw new Error('Unauthorized: Missing internal generation signature');

  const expected = crypto.createHmac('sha256', INTERNAL_SIGNING_KEY).update(rawBody, 'utf8').digest('hex');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error('Unauthorized: Invalid internal generation signature');
  }
}

async function getLatestFacts(caseId) {
  const { data, error } = await supabase.from('cases').select('case_facts').eq('id', caseId).maybeSingle();
  if (error) throw new Error(`Could not reload case facts: ${error.message}`);
  return data?.case_facts || {};
}

async function mergeFacts(caseId, patch = {}) {
  if (!supabase || !caseId) return {};
  const facts = await getLatestFacts(caseId);
  const merged = { ...facts, ...patch };
  const { error } = await supabase.from('cases').update({
    case_facts: merged,
    updated_at: new Date().toISOString()
  }).eq('id', caseId);
  if (error) throw new Error(`Could not record generation progress: ${error.message}`);
  return merged;
}

async function recordProgress(caseId, stage, extraFacts = {}) {
  return mergeFacts(caseId, {
    ...extraFacts,
    wp_letter_status: stage
  });
}

async function recordFailure(caseId, error) {
  if (!supabase || !caseId) return;
  const { data } = await supabase.from('cases').select('case_facts,payment_status').eq('id', caseId).maybeSingle();
  const facts = data?.case_facts || {};
  await supabase.from('cases').update({
    status: data?.payment_status === 'paid' ? 'paid_ready_for_drafting' : undefined,
    letter_status: 'generation_failed',
    case_facts: {
      ...facts,
      wp_letter_status: 'GENERATION_FAILED',
      wp_generation_error: String(error?.message || error).slice(0, 1000),
      wp_generation_failed_at: new Date().toISOString()
    },
    updated_at: new Date().toISOString()
  }).eq('id', caseId);
}

exports.handler = async (event) => {
  let caseId = null;
  try {
    const rawBody = event.body || '{}';
    const request = JSON.parse(rawBody);
    caseId = request.caseId;
    if (!caseId) throw new Error('Case ID required');

    if (!supabase) throw new Error('Supabase is not configured for letter generation');

    verifyInternalSignature(event, rawBody);

    await recordProgress(caseId, 'BACKGROUND_STARTED', {
      wp_background_started_at: new Date().toISOString(),
      wp_generation_error: null
    });

    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

    const senderVariant = normaliseSenderVariant(request.sender_variant || request.senderVariant || 'VRS');
    const clientSide = normaliseClientSide(request.client_side || request.clientSide || 'employee');

    const { data: caseData, error: caseErr } = await supabase
      .from('cases')
      .select('case_facts,payment_status,wp_generation_unlocked')
      .eq('id', caseId)
      .single();
    if (caseErr || !caseData) throw new Error(`Case not found: ${caseErr?.message || caseId}`);

    await recordProgress(caseId, 'CASE_LOADED', {
      wp_generation_case_loaded_at: new Date().toISOString()
    });

    const facts = caseData.case_facts || {};
    const isPaid = caseData.payment_status === 'paid' || facts.payment_status === 'paid';
    const isUnlocked = caseData.wp_generation_unlocked === true || facts.wp_generation_unlocked === true;
    if (!isPaid || !isUnlocked) throw new Error('Drafting is locked until PayFast confirms payment.');
    if (!canGenerateWpLetter(facts)) throw new Error(blockedReason(facts));

    const startedAt = new Date().toISOString();
    const generatingFacts = await mergeFacts(caseId, {
      wp_letter_status: 'GENERATING',
      wp_generation_started_at: startedAt,
      wp_generation_error: null
    });

    const { error: generatingUpdateError } = await supabase.from('cases').update({
      status: 'drafting_in_progress',
      letter_status: 'generating',
      case_facts: generatingFacts,
      updated_at: startedAt
    }).eq('id', caseId);
    if (generatingUpdateError) throw new Error(`Could not mark letter generation as started: ${generatingUpdateError.message}`);

    const skillSet = await loadWpSkillSet(supabase, { side: clientSide });
    await recordProgress(caseId, 'SKILLS_LOADED', {
      wp_generation_skills_loaded_at: new Date().toISOString()
    });

    const skillContext = buildProtectedPromptContext(skillSet);
    const caseBrief = buildCaseBrief({ facts, senderVariant, clientSide });

    await recordProgress(caseId, 'CLAUDE_STARTED', {
      wp_generation_claude_started_at: new Date().toISOString()
    });

    const { draft, log } = await callClaudeForWpDraft({ skillContext, caseBrief, skillSet });

    await recordProgress(caseId, 'CLAUDE_COMPLETED', {
      wp_generation_claude_completed_at: new Date().toISOString()
    });

    const partAStructure = normaliseLetterStructure(draft.part_a_letter || {});
    const partA = letterStructureToPlainText(partAStructure);
    const partB = draft.part_b_supervisory_assessment || {};
    if (!partA) throw new Error('Claude did not return a usable Part A letter structure');

    const latestFacts = await getLatestFacts(caseId);
    const existingLogs = Array.isArray(latestFacts.llm_call_logs) ? latestFacts.llm_call_logs : [];
    const completedAt = new Date().toISOString();
    const updatedFacts = {
      ...latestFacts,
      wp_letter_status: 'GENERATED_PENDING',
      wp_generation_mode: 'VRS_PROTECTED_SKILL_SET',
      wp_generation_completed_at: completedAt,
      wp_generation_error: null,
      wp_client_side: clientSide,
      wp_sender_variant: senderVariant,
      wp_skill_version: skillSet.version,
      wp_skill_hash: skillSet.skill_hash,
      wp_skill_manifest: skillSet.manifest,
      wp_letter_structure: partAStructure,
      wp_supervisory_assessment: partB,
      wp_template_required: draft.metadata?.template_required || (senderVariant === 'CLIENT_SENT' ? 'VRS_WP_Template_ClientSent.docx' : 'VRS_WP_Template_Master_NEW.docx'),
      llm_call_logs: [...existingLogs, log]
    };

    const { error: updateError } = await supabase.from('cases').update({
      status: 'draft_ready_for_review',
      draft_letter: partA,
      letter_status: 'pending_review',
      case_facts: updatedFacts,
      updated_at: completedAt
    }).eq('id', caseId);
    if (updateError) throw new Error(`Draft generated but could not be saved: ${updateError.message}`);

    console.log('Background letter generation completed', { caseId, model: log.model });
    return { statusCode: 200, body: JSON.stringify({ success: true, caseId }) };
  } catch (error) {
    console.error('Background Drafting Error:', { caseId, message: error.message, stack: error.stack });
    await recordFailure(caseId, error);
    const statusCode = String(error.message || '').startsWith('Unauthorized') ? 401 : 500;
    return { statusCode, body: JSON.stringify({ error: error.message }) };
  }
};
