const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const { scoreCase } = require('./lib/scoringEngine');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function getActiveLLM() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_name', 'active_llm')
    .single();
  return data ? data.setting_value : 'gemini';
}

async function runJsonLLM(prompt, fallback) {
  const activeLLM = await getActiveLLM();

  try {
    if (activeLLM === 'openai' && openai) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a routing JSON processor. Always return strictly formatted JSON.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });
      return JSON.parse(completion.choices[0].message.content);
    }

    const jsonModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await jsonModel.generateContent(prompt);
    return JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());
  } catch (err) {
    console.warn('LLM JSON call failed, using fallback:', err.message);
    return fallback;
  }
}

function buildLegalKeywords(facts, fullStory) {
  let legalKeywords = 'labour law South Africa';

  if (facts.employment_status === 'Dismissed') {
    legalKeywords += ' unfair dismissal';
    if (facts.dismissal_reason_type === 'Misconduct') legalKeywords += ' misconduct schedule 8';
    if (facts.dismissal_reason_type === 'Poor Performance') legalKeywords += ' poor work performance schedule 8 item 9';
    if (facts.dismissal_reason_type === 'Incapacity') legalKeywords += ' incapacity ill health injury items 10 11';
    if (facts.dismissal_reason_type === 'Retrenchment') legalKeywords += ' operational requirements retrenchment section 189';
  } else if (facts.employment_status === 'Resigned') {
    legalKeywords += ' constructive dismissal intolerable working conditions section 186(1)(e)';
  } else if (facts.employment_status === 'Discrimination') {
    legalKeywords += ' employment equity automatically unfair discrimination harassment section 187';
  } else if (facts.employment_status === 'Advisory' || facts.employment_status === 'Employed') {
    legalKeywords += ' BCEA grievance disciplinary hearing unfair labour practice';
  }

  if (facts.hearing_held === false || facts.proc_notice === 'none') legalKeywords += ' procedural fairness no hearing';
  if (facts.proc_notice === false) legalKeywords += ' no 48 hours notice';
  if (facts.proc_rep === false) legalKeywords += ' denied representation';
  if (facts.proc_chair === false) legalKeywords += ' biased chairperson';
  if (facts.proc_consultation === false) legalKeywords += ' failure to consult alternatives';
  if (facts.paid_suspension === false) legalKeywords += ' unpaid suspension section 186(2)(b)';
  if (facts.contract_type === 'Contractor') legalKeywords += ' independent contractor jurisdiction';

  return `${fullStory} ${facts.sector || ''} ${legalKeywords}`;
}

async function searchLegalContext(searchQuery) {
  try {
    const embeddingModel = genAI.getGenerativeModel({ model: 'models/gemini-embedding-001' });
    const embeddingResult = await embeddingModel.embedContent(searchQuery);
    const { data: chunks, error } = await supabase.rpc('hybrid_search', {
      query_text: searchQuery,
      query_embedding: embeddingResult.embedding.values,
      match_count: 5,
      full_text_weight: 1.0,
      semantic_weight: 2.0,
      rrf_k: 50
    });

    if (error) throw error;
    return chunks ? chunks.map(c => c.content).join('\n\n') : 'No specific case law found.';
  } catch (err) {
    console.warn('Legal context search failed:', err.message);
    return 'Legal context search unavailable. Deterministic scoring completed without RAG context.';
  }
}

function normalizeCoreFacts(facts, fullStory, scorecard, contextText) {
  return {
    client_name: facts.client_name || null,
    contact_info: facts.contact_info || null,
    employer_name: facts.employer_name || null,
    employer_contact_details: facts.employer_contact_details || null,
    incident_date: facts.incident_date || null,
    incident_description: fullStory || null,
    employment_status: facts.employment_status || null,
    dismissal_reason_type: facts.dismissal_reason_type || null,
    advisory_topic: facts.advisory_topic || null,
    hearing_held: facts.hearing_held !== undefined ? facts.hearing_held : null,
    proc_notice: facts.proc_notice !== undefined ? facts.proc_notice : null,
    proc_rep: facts.proc_rep !== undefined ? facts.proc_rep : null,
    proc_chair: facts.proc_chair !== undefined ? facts.proc_chair : null,
    proc_consultation: facts.proc_consultation !== undefined ? facts.proc_consultation : null,
    paid_suspension: facts.paid_suspension !== undefined ? facts.paid_suspension : null,
    constructive_dismissal: facts.constructive_dismissal !== undefined ? facts.constructive_dismissal : null,
    sector: facts.sector || null,
    contract_type: facts.contract_type || null,
    wants_letter: null,

    track: scorecard.track,
    track_label: scorecard.track_label,
    substantive_score: scorecard.substantive_score,
    procedural_score: scorecard.procedural_score,
    merit_band: scorecard.merit_band,
    overall_viability: scorecard.recommended_next_step,
    recommended_next_step: scorecard.recommended_next_step,
    wp_eligible: scorecard.wp_eligible,
    wp_type: scorecard.wp_type,
    ccma_deadline_status: scorecard.ccma_deadline_status,
    hard_disqualifier: scorecard.hard_disqualifier,
    merit_bonus_trigger: scorecard.merit_bonus_trigger,
    strengths: scorecard.scoring_breakdown.filter(item => item.points > 0).map(item => item.label),
    weaknesses: scorecard.scoring_breakdown.filter(item => item.points < 0).map(item => item.label),
    scoring_breakdown: scorecard.scoring_breakdown,
    legal_basis: scorecard.legal_basis,
    attorney_review_flag: true,
    legal_context_snapshot: contextText
  };
}

function buildTriageFacts(facts = {}, outcome = 'UNKNOWN') {
  const outcomeMap = {
    CONTRACTOR: {
      label: 'Independent contractor triage',
      recommended_forum: 'Civil contract advice / dominant impression assessment',
      legal_basis: ['LRA s200A; dominant impression test']
    },
    CROSS_BORDER: {
      label: 'Cross-border jurisdiction triage',
      recommended_forum: 'International or cross-border employment advice',
      legal_basis: ['LRA s4; jurisdictional reach']
    },
    PUBLIC_SERVICE: {
      label: 'Public service / government agency triage',
      recommended_forum: 'PSCBC, GPSSBC, ELRC, SSSBC or military grievance procedures, depending on employer and sector',
      legal_basis: ['LRA s2(2)', 'LRA s9', 'Public-sector bargaining council jurisdiction']
    },
    SOE_UNCLEAR: {
      label: 'Schedule 2 SOE eligibility triage',
      recommended_forum: 'Attorney review to confirm CCMA eligibility or correct bargaining council/forum',
      legal_basis: ['LRA general application; case-by-case sectoral assessment']
    },
    UNKNOWN: {
      label: 'Jurisdiction triage',
      recommended_forum: 'Attorney review required',
      legal_basis: ['Jurisdiction to be confirmed']
    }
  };

  const config = outcomeMap[outcome] || outcomeMap.UNKNOWN;
  return {
    track: 'JURISDICTION_TRIAGE',
    track_label: config.label,
    jurisdiction_outcome: outcome,
    recommended_forum: config.recommended_forum,
    legal_basis: config.legal_basis,
    jurisdiction_answers: {
      worker_status: facts.worker_status || null,
      contractor_control_test: facts.contractor_control_test || null,
      south_african_employer: facts.south_african_employer || null,
      public_service_or_excluded_agency: facts.public_service_or_excluded_agency || null,
      schedule_2_soe_ccma_eligible: facts.schedule_2_soe_ccma_eligible || null
    },
    wp_eligible: false,
    wp_type: null,
    merit_band: 'NO MERIT',
    recommended_next_step: `Jurisdiction triage captured. Recommended forum: ${config.recommended_forum}.`,
    attorney_review_flag: true,
    wp_letter_status: 'NOT_APPLICABLE'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action;

    if (action === 'classify') {
      const userText = body.text || '';
      const prompt = `
You are a South African Labour Law triage router.

The user has provided the following initial query: "${userText}"

TASK 1: CATEGORIZE
Categorize their issue strictly into ONE of the following exact strings:
- "Dismissed" (User was fired, retrenched, let go, or contract ended)
- "Resigned" (User quit, forced to resign, or constructively dismissed)
- "Discrimination" (User faces racism, sexism, harassment, EEA issues, pregnancy, whistleblowing, union activity, or other protected-ground issues)
- "Advisory" (User is still employed and needs help with a warning, grievance, hearing prep, pay issue, reference letter, or BCEA issue)
- "UIF" (User is explicitly asking about Unemployment Insurance Fund claims)
If the user's text is too vague, short, or ambiguous, return "Ambiguous".

TASK 2: SMART EXTRACTION
If the user provided enough detail in their story, extract the sub-category so we don't have to ask them again. If it is NOT obvious, return null.
- "dismissal_reason_type": Only if category is Dismissed. Choose strictly from: "Misconduct", "Poor Performance", "Incapacity", "Retrenchment".
- "advisory_topic": Only if category is Advisory. Choose strictly from: "Hearing Prep", "Warning", "Grievance", "Pay Issue".
- "confidence": A number between 0 and 1 reflecting how confident you are in the category.

Return ONLY a JSON object with this exact format:
{ "category": "String", "dismissal_reason_type": "String or null", "advisory_topic": "String or null", "confidence": number }
`;

      const resultData = await runJsonLLM(prompt, {
        category: 'Ambiguous',
        dismissal_reason_type: null,
        advisory_topic: null,
        confidence: 0
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resultData)
      };
    }

    if (action === 'triage') {
      const facts = body.facts || {};
      const outcome = body.outcome || 'UNKNOWN';
      const triageFacts = buildTriageFacts(facts, outcome);

      const { data: newCase, error: dbErr } = await supabase
        .from('cases')
        .insert({
          client_name: facts.client_name || 'Jurisdiction triage lead',
          contact_info: facts.contact_info || null,
          issue_summary: triageFacts.recommended_next_step,
          case_facts: triageFacts,
          status: 'jurisdiction_triage',
          letter_status: 'not_applicable'
        })
        .select()
        .single();

      if (dbErr) throw new Error(`Jurisdiction triage save failed: ${dbErr.message}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          caseId: newCase.id,
          triage: triageFacts,
          message: triageFacts.recommended_next_step
        })
      };
    }

    if (action === 'evaluate') {
      const facts = body.facts || {};
      const fullStory = `${facts.initial_query ? `${facts.initial_query} ` : ''}${facts.incident_description || ''}`.trim();
      const searchQuery = buildLegalKeywords(facts, fullStory);
      const contextText = await searchLegalContext(searchQuery);
      const scorecard = scoreCase({ ...facts, incident_description: fullStory });
      const coreFacts = normalizeCoreFacts(facts, fullStory, scorecard, contextText);

      const dbPayload = {
        client_name: facts.client_name,
        contact_info: facts.contact_info,
        issue_summary: fullStory || 'Gathered via automated intake.',
        case_facts: coreFacts,
        status: 'new',
        letter_status: scorecard.wp_eligible ? 'not_drafted' : 'not_applicable'
      };

      const { data: newCase, error: dbErr } = await supabase
        .from('cases')
        .insert(dbPayload)
        .select()
        .single();

      if (dbErr) throw new Error(`Database save failed: ${dbErr.message}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pitch: scorecard.advisory_note,
          hasMerit: scorecard.wp_eligible,
          caseId: newCase.id,
          scorecard
        })
      };
    }

    if (action === 'close') {
      const { caseId, wants_letter } = body;
      const updatePayload = { updated_at: new Date().toISOString() };

      const { data: existingCase, error: readErr } = await supabase
        .from('cases')
        .select('case_facts')
        .eq('id', caseId)
        .single();
      if (readErr) throw new Error(`Case lookup failed: ${readErr.message}`);

      const caseFacts = existingCase && existingCase.case_facts ? existingCase.case_facts : {};
      const wpEligible = caseFacts.wp_eligible === true;

      if (wants_letter && wpEligible) {
        updatePayload.status = 'requires_attorney';
        updatePayload.letter_status = 'needs_drafting';
      } else if (wants_letter && !wpEligible) {
        updatePayload.status = 'advisory_only';
        updatePayload.letter_status = 'not_applicable';
      }

      updatePayload.case_facts = { ...caseFacts, wants_letter };

      await supabase.from('cases').update(updatePayload).eq('id', caseId);

      let closingMsg;
      if (wants_letter && wpEligible) {
        closingMsg = 'Excellent. I have sent your file to the legal team for attorney review. If a Without Prejudice letter is prepared, it will remain pending until a VRS attorney reviews and releases it.';
      } else if (wants_letter && !wpEligible) {
        closingMsg = 'I have saved your file, but based on the current assessment this matter is advisory-only and a Without Prejudice demand letter is not currently recommended.';
      } else {
        closingMsg = 'No problem at all. I have saved your file. If you change your mind, you can reach out to us again.';
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closing_message: closingMsg })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action provided' }) };
  } catch (error) {
    console.error('Server Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
