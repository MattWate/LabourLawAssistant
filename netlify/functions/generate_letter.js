const { createClient } = require('@supabase/supabase-js');
const { loadWpSkillSet, buildProtectedPromptContext } = require('./lib/skillRegistry');
const { buildCaseBrief, callClaudeForWpDraft } = require('./lib/claudeDrafting');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function canGenerateWpLetter(facts = {}) {
  if (facts.wp_eligible !== true) return false;
  if (facts.hard_disqualifier) return false;
  return true;
}

function blockedReason(facts = {}) {
  if (facts.hard_disqualifier) return 'The case has a hard disqualifier and cannot generate a Without Prejudice letter until reviewed.';
  if (facts.wp_eligible !== true) return 'The Strategic Engagement Matrix did not recommend a Without Prejudice letter.';
  return 'This case is not eligible for a Without Prejudice demand letter under the current scoring matrix.';
}

function normaliseSenderVariant(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (['client', 'client_sent', 'client-sent', 'own_name', 'own-name', 'self'].includes(text)) return 'CLIENT_SENT';
  return 'VRS';
}

function normaliseClientSide(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return text === 'employer' ? 'employer' : 'employee';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Authentication Token' }) };
  }

  try {
    const request = JSON.parse(event.body || '{}');
    const { caseId } = request;
    if (!caseId) return { statusCode: 400, body: JSON.stringify({ error: 'Case ID required' }) };

    const senderVariant = normaliseSenderVariant(request.sender_variant || request.senderVariant || 'VRS');
    const clientSide = normaliseClientSide(request.client_side || request.clientSide || 'employee');

    const { data: caseData, error: caseErr } = await supabase
      .from('cases')
      .select('case_facts')
      .eq('id', caseId)
      .single();

    if (caseErr || !caseData) throw new Error('Case not found');

    const facts = caseData.case_facts || {};

    if (!canGenerateWpLetter(facts)) {
      await supabase
        .from('cases')
        .update({
          letter_status: 'not_applicable',
          case_facts: {
            ...facts,
            wp_letter_status: 'NOT_APPLICABLE',
            wp_generation_blocked_reason: blockedReason(facts)
          }
        })
        .eq('id', caseId);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          blocked: true,
          message: blockedReason(facts)
        })
      };
    }

    const skillSet = await loadWpSkillSet(supabase, { side: clientSide });
    const skillContext = buildProtectedPromptContext(skillSet);
    const caseBrief = buildCaseBrief({ facts, senderVariant, clientSide });
    const { draft, log } = await callClaudeForWpDraft({ skillContext, caseBrief, skillSet });

    const partA = String(draft.part_a_letter || '').trim();
    const partB = draft.part_b_supervisory_assessment || {};
    if (!partA) throw new Error('Claude did not return a Part A letter');

    const existingLogs = Array.isArray(facts.llm_call_logs) ? facts.llm_call_logs : [];
    const updatedFacts = {
      ...facts,
      wp_letter_status: 'GENERATED_PENDING',
      wp_generation_mode: 'VRS_PROTECTED_SKILL_SET',
      wp_client_side: clientSide,
      wp_sender_variant: senderVariant,
      wp_skill_version: skillSet.version,
      wp_skill_hash: skillSet.skill_hash,
      wp_skill_manifest: skillSet.manifest,
      wp_supervisory_assessment: partB,
      wp_template_required: draft.metadata?.template_required || (senderVariant === 'CLIENT_SENT' ? 'VRS_WP_Template_ClientSent.docx' : 'VRS_WP_Template_Master.docx'),
      llm_call_logs: [...existingLogs, log]
    };

    await supabase
      .from('cases')
      .update({
        draft_letter: partA,
        supervisory_assessment: partB,
        letter_status: 'pending_review',
        case_facts: updatedFacts
      })
      .eq('id', caseId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        letter: partA,
        supervisory_assessment: partB,
        metadata: {
          client_side: clientSide,
          sender_variant: senderVariant,
          skill_version: skillSet.version,
          skill_hash: skillSet.skill_hash,
          template_required: updatedFacts.wp_template_required
        },
        message: 'Draft generated using the protected VRS skill set and held pending attorney review.'
      })
    };
  } catch (error) {
    console.error('Drafting Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};