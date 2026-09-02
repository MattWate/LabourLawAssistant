const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const { scoreCase } = require('./lib/scoringEngine');
const { applyOverridePostProcessing } = require('./lib/overridePostProcessor');
const { classifyAndHydrateMatter, mergeGovernanceFacts } = require('./lib/llmGovernance');
const { caseReference } = require('./lib/caseReference');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function normaliseWhatsAppNumber(value = "") {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 10) digits = `27${digits.slice(1)}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function linkWebCaseToWhatsApp({ caseId, facts = {}, caseFacts = {} }) {
  const number = normaliseWhatsAppNumber(facts.whatsapp_number || facts.contact_info);
  if (!number) return { linked: false, reason: "no_valid_whatsapp_number" };

  const now = new Date().toISOString();
  const payload = {
    from_number: number,
    contact_name: facts.client_name || null,
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    current_step: "COMPLETE",
    status: "completed",
    collected_facts: { ...caseFacts, contact_info: number, whatsapp_number: number, source: facts.source || "web" },
    case_id: caseId,
    handoff_reason: null,
    error_message: null,
    last_inbound_at: null,
    updated_at: now
  };

  const { data: existing, error: readError } = await supabase
    .from("whatsapp_conversations")
    .select("id")
    .eq("from_number", number)
    .maybeSingle();
  if (readError) throw readError;

  if (existing?.id) {
    const { error } = await supabase.from("whatsapp_conversations").update(payload).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("whatsapp_conversations").insert({ ...payload, processed_message_ids: [], created_at: now });
    if (error) throw error;
  }

  return { linked: true, number };
}

async function getActiveLLM() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_name', 'active_llm')
    .single();
  return data?.setting_value || 'gemini';
}

async function classifyText(text = '') {
  const governance = await classifyAndHydrateMatter({ narrative: text, existingFacts: { initial_query: text } });

  if (governance.ok) {
    return {
      ...governance.compatibility,
      governance,
      hydrated_facts: governance.hydrated_facts,
      primary_track: governance.primary_track,
      secondary_track: governance.secondary_track,
      override_flags: governance.override_flags
    };
  }

  const prompt = `Classify this South African labour-law intake into JSON only.
Text: ${text}
Return: {"category":"Dismissed|Resigned|Discrimination|Advisory|UIF|Ambiguous","dismissal_reason_type":"Misconduct|Poor Performance|Incapacity|Retrenchment|null","advisory_topic":"Hearing Prep|Warning|Grievance|Pay Issue|null","confidence":0.0}`;

  const fallback = { category: 'Ambiguous', dismissal_reason_type: null, advisory_topic: null, confidence: 0, governance };
  try {
    const activeLLM = await getActiveLLM();
    if (activeLLM === 'openai' && openai) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });
      return { ...JSON.parse(completion.choices[0].message.content), governance };
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await model.generateContent(prompt);
    return { ...JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim()), governance };
  } catch (error) {
    console.warn('Classification failed:', error.message);
    return fallback;
  }
}

function buildLegalKeywords(facts = {}, story = '') {
  const parts = ['labour law South Africa', story, facts.sector || ''];
  if (facts.employment_status === 'Dismissed') parts.push('unfair dismissal');
  if (facts.dismissal_reason_type) parts.push(String(facts.dismissal_reason_type));
  if (facts.employment_status === 'Resigned') parts.push('constructive dismissal section 186(1)(e)');
  if (facts.employment_status === 'Discrimination') parts.push('employment equity automatically unfair dismissal section 187');
  if (facts.hearing_held === false) parts.push('no hearing procedural fairness');
  if (facts.paid_suspension === false) parts.push('suspension without pay unfair labour practice section 186(2)(b)');
  if (facts.proc_notice === false) parts.push('no 48 hours notice');
  if (facts.proc_rep === false) parts.push('denied representation');
  if (facts.proc_chair === false) parts.push('biased chairperson');
  if (facts.proc_consultation === false) parts.push('failure to consult');
  if (Array.isArray(facts.override_flags)) parts.push(facts.override_flags.join(' '));
  return parts.filter(Boolean).join(' ');
}

async function searchLegalContext(query) {
  try {
    const embeddingModel = genAI.getGenerativeModel({ model: 'models/gemini-embedding-001' });
    const embeddingResult = await embeddingModel.embedContent(query);
    const { data, error } = await supabase.rpc('hybrid_search', {
      query_text: query,
      query_embedding: embeddingResult.embedding.values,
      match_count: 5,
      full_text_weight: 1.0,
      semantic_weight: 2.0,
      rrf_k: 50
    });
    if (error) throw error;
    return data ? data.map(row => row.content).join('\n\n') : 'No specific legal context found.';
  } catch (error) {
    console.warn('RAG search failed:', error.message);
    return 'Legal context search unavailable.';
  }
}

function buildCoreFacts(facts = {}, story = '', scorecard = {}, contextText = '') {
  return {
    client_name: facts.client_name || null,
    contact_info: facts.contact_info || null,
    employer_name: facts.employer_name || null,
    employer_contact_details: facts.employer_contact_details || null,
    incident_date: facts.incident_date || null,
    incident_description: story || null,
    employment_status: facts.employment_status || null,
    dismissal_reason_type: facts.dismissal_reason_type || null,
    advisory_topic: facts.advisory_topic || null,
    ancillary_topic: facts.ancillary_topic || null,
    hearing_held: facts.hearing_held ?? null,
    proc_notice: facts.proc_notice ?? null,
    proc_rep: facts.proc_rep ?? null,
    proc_chair: facts.proc_chair ?? null,
    proc_consultation: facts.proc_consultation ?? null,
    paid_suspension: facts.paid_suspension ?? null,
    constructive_dismissal: facts.constructive_dismissal ?? null,
    sector: facts.sector || null,
    contract_type: facts.contract_type || null,
    wants_letter: null,
    track: scorecard.track,
    track_label: scorecard.track_label,
    secondary_track: scorecard.secondary_track || null,
    override_flags: scorecard.override_flags || [],
    substantive_score: scorecard.substantive_score,
    procedural_score: scorecard.procedural_score,
    merit_band: scorecard.merit_band,
    recommended_next_step: scorecard.recommended_next_step,
    overall_viability: scorecard.recommended_next_step,
    wp_eligible: scorecard.wp_eligible,
    wp_type: scorecard.wp_type,
    ccma_deadline_status: scorecard.ccma_deadline_status,
    hard_disqualifier: scorecard.hard_disqualifier,
    merit_bonus_trigger: scorecard.merit_bonus_trigger,
    strengths: (scorecard.scoring_breakdown || []).filter(x => x.points > 0).map(x => x.label),
    weaknesses: (scorecard.scoring_breakdown || []).filter(x => x.points < 0).map(x => x.label),
    scoring_breakdown: scorecard.scoring_breakdown || [],
    legal_basis: scorecard.legal_basis || [],
    attorney_review_flag: true,
    legal_context_snapshot: contextText,
    llm_governance: facts.llm_governance || null,
    llm_call_logs: facts.llm_call_logs || []
  };
}

function buildTriageFacts(facts = {}, outcome = 'UNKNOWN') {
  const map = {
    CONTRACTOR: ['Independent contractor triage', 'Civil contract advice / dominant impression assessment', ['LRA s200A; dominant impression test']],
    CROSS_BORDER: ['Cross-border jurisdiction triage', 'International or cross-border employment advice', ['LRA s4; jurisdictional reach']],
    PUBLIC_SERVICE: ['Public service / government agency triage', 'PSCBC, GPSSBC, ELRC, SSSBC or military grievance procedures, depending on employer and sector', ['LRA s2(2)', 'LRA s9']],
    SOE_UNCLEAR: ['Schedule 2 SOE eligibility triage', 'VRS review to confirm CCMA eligibility or correct bargaining council/forum', ['LRA general application; case-by-case sectoral assessment']],
    UNKNOWN: ['Jurisdiction triage', 'VRS review required', ['Jurisdiction to be confirmed']]
  };
  const [label, forum, legal] = map[outcome] || map.UNKNOWN;
  return {
    track: 'JURISDICTION_TRIAGE',
    track_label: label,
    jurisdiction_outcome: outcome,
    recommended_forum: forum,
    legal_basis: legal,
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
    recommended_next_step: `Jurisdiction triage captured. Recommended forum: ${forum}.`,
    attorney_review_flag: true,
    wp_letter_status: 'NOT_APPLICABLE'
  };
}

function clientOutcomeFor(facts = {}, scorecard = facts) {
  const wpEligible = scorecard.wp_eligible === true || facts.wp_eligible === true;
  const track = String(scorecard.track || facts.track || '').toUpperCase();
  const employmentStatus = String(facts.employment_status || '').toLowerCase();
  const advisoryMatter = ['ANC', 'PDA', 'ULP'].includes(track) || employmentStatus.includes('advisory') || employmentStatus.includes('still employed');

  if (wpEligible) {
    return 'Thank you for sharing your information with us. Based on what you have told us, it looks like your matter may have sufficient merit to take further and a Without Prejudice letter may be appropriate. Your information has been forwarded to VRS Labour Law Consultants for review and the next step in the letter process.';
  }

  if (advisoryMatter) {
    return 'Thank you for your submission. This looks like something we can help guide you on, though it is not a matter that calls for a Without Prejudice letter at this stage. One of our consultants will be in touch with practical next steps.';
  }

  return 'Thank you for taking the time to share your information with us. Having carefully considered what you have told us, this is not something we are able to take further through the Without Prejudice letter process. Based on the details provided, there does not appear to be sufficient merit for that step at this stage. We are sorry we cannot assist with a letter on this occasion and we wish you all the very best.';
}

function dedupeStory(text = '') {
  const value = String(text || '').trim();
  if (!value) return '';
  const midpoint = Math.floor(value.length / 2);
  const first = value.slice(0, midpoint).trim();
  const second = value.slice(midpoint).trim();
  if (first && second && first === second) return first;
  return value;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action;

    if (action === 'classify') {
      const result = await classifyText(body.text || '');
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
    }

    if (action === 'triage') {
      const triage = buildTriageFacts(body.facts || {}, body.outcome || 'UNKNOWN');
      const { data, error } = await supabase.from('cases').insert({
        client_name: body.facts?.client_name || 'Jurisdiction triage lead',
        contact_info: body.facts?.contact_info || null,
        issue_summary: triage.recommended_next_step,
        case_facts: triage,
        status: 'jurisdiction_triage',
        letter_status: 'not_applicable'
      }).select().single();
      if (error) throw error;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, caseId: data.id, caseReference: caseReference(data.id, data.created_at), triage, message: triage.recommended_next_step }) };
    }

    if (action === 'evaluate') {
      const originalFacts = body.facts || {};
      const initialStory = dedupeStory(`${originalFacts.initial_query ? `${originalFacts.initial_query} ` : ''}${originalFacts.incident_description || ''}`.trim());
      const governance = await classifyAndHydrateMatter({ narrative: initialStory, existingFacts: originalFacts });
      const facts = mergeGovernanceFacts(originalFacts, governance);
      const fullStory = dedupeStory(`${facts.initial_query ? `${facts.initial_query} ` : ''}${facts.incident_description || ''}`.trim());
      const contextText = await searchLegalContext(buildLegalKeywords(facts, fullStory));
      const scoringInput = { ...facts, incident_description: fullStory };
      const baseScorecard = scoreCase(scoringInput);
      const scorecard = applyOverridePostProcessing(scoringInput, fullStory, baseScorecard);
      const caseFacts = buildCoreFacts(facts, fullStory, scorecard, contextText);
      const clientOutcome = clientOutcomeFor(caseFacts, scorecard);

      const { data, error } = await supabase.from('cases').insert({
        client_name: facts.client_name,
        contact_info: facts.contact_info,
        issue_summary: fullStory || 'Gathered via automated intake.',
        case_facts: { ...caseFacts, client_outcome_message: clientOutcome },
        status: 'new',
        letter_status: scorecard.wp_eligible ? 'not_drafted' : 'not_applicable'
      }).select().single();
      if (error) throw error;

      let whatsapp = { linked: false, reason: 'not_web_intake' };
      if (facts.source === 'web' || facts.whatsapp_number) {
        try {
          whatsapp = await linkWebCaseToWhatsApp({ caseId: data.id, facts, caseFacts: { ...caseFacts, client_outcome_message: clientOutcome } });
          if (whatsapp.linked) {
            const normalisedFacts = { ...caseFacts, client_outcome_message: clientOutcome, contact_info: whatsapp.number, whatsapp_number: whatsapp.number, source: 'web' };
            await supabase.from('cases').update({
              contact_info: whatsapp.number,
              case_facts: normalisedFacts,
              updated_at: new Date().toISOString()
            }).eq('id', data.id);
          }
        } catch (linkError) {
          console.warn('Web case WhatsApp linking failed:', linkError.message);
          whatsapp = { linked: false, reason: linkError.message };
        }
      }

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pitch: clientOutcome, clientOutcome, internalAssessment: scorecard.advisory_note, hasMerit: scorecard.wp_eligible, caseId: data.id, caseReference: caseReference(data.id, data.created_at), scorecard, governance: caseFacts.llm_governance, whatsapp }) };
    }

    if (action === 'close') {
      const { caseId, wants_letter } = body;
      const { data: existing, error: readErr } = await supabase.from('cases').select('case_facts').eq('id', caseId).single();
      if (readErr) throw readErr;
      const caseFacts = existing?.case_facts || {};
      const wpEligible = caseFacts.wp_eligible === true;
      const updatePayload = { updated_at: new Date().toISOString(), case_facts: { ...caseFacts, wants_letter } };
      if (wants_letter && wpEligible) {
        updatePayload.status = 'requires_attorney';
        updatePayload.letter_status = 'needs_drafting';
      } else if (wants_letter && !wpEligible) {
        updatePayload.status = 'advisory_only';
        updatePayload.letter_status = 'not_applicable';
      }
      await supabase.from('cases').update(updatePayload).eq('id', caseId);
      const closing_message = wants_letter && wpEligible
        ? 'Thank you. Your request for a Without Prejudice letter has been recorded and sent to VRS Labour Law Consultants for review. VRS will guide you through the next step.'
        : wpEligible
          ? 'Thank you. Your information has been saved. If you decide that you would like VRS to assist with a Without Prejudice letter, please contact VRS and quote your case reference.'
          : 'Thank you. Your submission has been recorded.';
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closing_message }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action provided' }) };
  } catch (error) {
    console.error('Server Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};