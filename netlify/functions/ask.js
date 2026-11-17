const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const { scoreCase, inferTrack } = require('./lib/scoringEngine');
const { applyOverridePostProcessing } = require('./lib/overridePostProcessor');
const { classifyAndHydrateMatter, mergeGovernanceFacts } = require('./lib/llmGovernance');
const { caseReference } = require('./lib/caseReference');
const { factsForDeterministicDecision, buildFactTrace } = require('./lib/factProvenance');
const { processClientTurn } = require('./lib/intakeConversation');
const { explainDeterministicDetermination } = require('./lib/determinationExplanation');
const { CONSENT_CONFIG, consentSnapshot } = require('./lib/consentConfig');
const { compareClientEmployerEmail, cleanEmail } = require('./lib/emailPrivacy');
const { retentionMetadata } = require('./lib/privacyGovernance');
const { determineProductRoute } = require('./lib/productRouting');
const { deadlineStatus, deadlineMessage } = require('./lib/intakeSafety');

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


function checkpointHash(token = '') {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cleanCheckpointFacts(facts = {}) {
  const copy = { ...(facts || {}) };
  delete copy._checkpoint_token;
  delete copy._intake_events_buffer;
  return copy;
}

function normaliseIntakeEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events.slice(-200).map(event => ({
    id: event.id || crypto.randomUUID(),
    type: String(event.type || 'event'),
    at: event.at || new Date().toISOString(),
    state: event.state || null,
    field: event.field || null,
    value: event.value ?? null,
    meta: event.meta || null
  }));
}

async function readCheckpoint(caseId, token) {
  if (!caseId || !token) return null;
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const expected = data.case_facts?._intake_checkpoint_token_hash;
  if (!expected || expected !== checkpointHash(token)) return null;
  return data;
}

async function saveIntakeCheckpoint({ caseId, token, facts = {}, events = [] }) {
  const now = new Date().toISOString();
  const incoming = normaliseIntakeEvents(events);

  if (!caseId) {
    const newToken = crypto.randomBytes(24).toString('hex');
    const cleanFacts = cleanCheckpointFacts(facts);
    const caseFacts = {
      ...cleanFacts,
      _intake_checkpoint: true,
      _intake_checkpoint_token_hash: checkpointHash(newToken),
      _intake_events: incoming,
      _intake_checkpoint_updated_at: now,
      attorney_review_flag: true
    };
    const { data, error } = await supabase.from('cases').insert({
      client_name: cleanFacts.client_name || 'Intake in progress',
      contact_info: cleanFacts.whatsapp_number || cleanFacts.contact_info || cleanFacts.client_email || null,
      issue_summary: cleanFacts.initial_query || cleanFacts.incident_description || 'Intake in progress.',
      case_facts: caseFacts,
      status: 'intake_in_progress',
      letter_status: 'not_drafted'
    }).select().single();
    if (error) throw error;
    return {
      caseId: data.id,
      caseReference: data.client_reference || caseReference(data.id, data.created_at),
      checkpointToken: newToken,
      eventCount: incoming.length
    };
  }

  const existing = await readCheckpoint(caseId, token);
  if (!existing) throw new Error('Invalid intake checkpoint');
  const priorFacts = existing.case_facts || {};
  const priorEvents = Array.isArray(priorFacts._intake_events) ? priorFacts._intake_events : [];
  const knownIds = new Set(priorEvents.map(event => event?.id).filter(Boolean));
  const appended = incoming.filter(event => !knownIds.has(event.id));
  const cleanFacts = cleanCheckpointFacts(facts);
  const caseFacts = {
    ...priorFacts,
    ...cleanFacts,
    _intake_checkpoint: true,
    _intake_checkpoint_token_hash: priorFacts._intake_checkpoint_token_hash,
    _intake_events: [...priorEvents, ...appended].slice(-500),
    _intake_checkpoint_updated_at: now
  };
  const { error } = await supabase.from('cases').update({
    client_name: cleanFacts.client_name || existing.client_name,
    contact_info: cleanFacts.whatsapp_number || cleanFacts.contact_info || cleanFacts.client_email || existing.contact_info,
    issue_summary: cleanFacts.initial_query || cleanFacts.incident_description || existing.issue_summary,
    case_facts: caseFacts,
    updated_at: now
  }).eq('id', caseId);
  if (error) throw error;
  return {
    caseId,
    caseReference: existing.client_reference || caseReference(existing.id, existing.created_at),
    checkpointToken: token,
    eventCount: priorEvents.length + appended.length
  };
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
    client_email: facts.client_email || null,
    whatsapp_number: facts.whatsapp_number || null,
    consent: facts.consent || null,
    employer_name: facts.employer_name || null,
    employer_registered_name: facts.employer_registered_name || facts.employer_name || null,
    employer_contact_details: facts.employer_contact_details || null,
    addressee_name: facts.addressee_name || null,
    addressee_position: facts.addressee_position || null,
    incident_date: facts.incident_date || null,
    incident_description: story || null,
    original_client_narrative: facts.original_client_narrative || facts.initial_query || null,
    normalized_english_interpretation: facts.normalized_english_interpretation || null,
    input_language_detected: facts.input_language_detected || null,
    input_language_confidence: facts.input_language_confidence ?? null,
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
    llm_call_logs: facts.llm_call_logs || [],
    privacy_governance: facts.privacy_governance || retentionMetadata({ channel: facts.source || 'web' })
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
    wp_letter_status: 'NOT_APPLICABLE',
    privacy_governance: facts.privacy_governance || retentionMetadata({ channel: facts.source || 'web' })
  };
}

function clientOutcomeFor(facts = {}, scorecard = facts) {
  const wpEligible = scorecard.wp_eligible === true || facts.wp_eligible === true;
  const track = String(scorecard.track || facts.track || '').toUpperCase();
  const employmentStatus = String(facts.employment_status || '').toLowerCase();
  const advisoryMatter = ['ANC', 'PDA', 'ULP'].includes(track) || employmentStatus.includes('advisory') || employmentStatus.includes('still employed');
  const deadline = scorecard.ccma_deadline_status || facts.ccma_deadline_status || {};
  const deadlinePrefix = deadline.status === 'LAPSED-CONDONATION'
    ? `Important: based on the date you gave us, the ordinary 30-day CCMA referral period appears to have passed by ${deadline.daysOverdue ?? 'an unknown number of'} days. Condonation may be required, so this needs urgent review. `
    : deadline.status === 'WITHIN_WINDOW' && Number(deadline.daysRemaining) <= 7
      ? `Important: based on the date you gave us, there are only ${deadline.daysRemaining} days left in the ordinary 30-day CCMA referral period. Do not wait for settlement discussions before protecting the deadline. `
      : '';

  if (wpEligible) {
    const dismissalMatter = employmentStatus.includes('dismiss') ||
      employmentStatus.includes('resign') ||
      track.startsWith('UD-') ||
      track === 'CD' ||
      track === 'AUD';
    const meritDescription = dismissalMatter
      ? 'you may have a strong case for a possible unfair dismissal claim'
      : 'your matter may have sufficient merit to take further';

    return deadlinePrefix + `Thank you for sharing your information with us. Based on what you have told us, it looks like ${meritDescription}. Your information has been forwarded to VRS Labour Law Consultants, who will be in touch to finalise your Without Prejudice letter.`;
  }

  if (advisoryMatter) {
    return deadlinePrefix + 'Thank you for your submission. This looks like something we can help guide you on, though it is not a matter that calls for a Without Prejudice letter at this stage. One of our consultants will be in touch with practical next steps.';
  }

  return deadlinePrefix + 'Thank you for taking the time to share your information with us. Having carefully considered what you have told us, this is not something we are able to take further. Based on the details provided, it appears your employer followed a fair process and had a valid reason for their decision. We are sorry we cannot assist on this occasion and we wish you all the very best.';
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

    if (action === 'consent_config') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(CONSENT_CONFIG)
      };
    }

    if (action === 'validate_client_email') {
      const result = compareClientEmployerEmail({
        clientEmail: body.clientEmail,
        employerEmail: body.employerEmail
      });
      return {
        statusCode: result.ok ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result)
      };
    }


    if (action === 'intake_safety_version') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '2026-11-17-v2', checkpointing: true, candidate_dates: true, immediate_deadlines: true, priority_budget: true })
      };
    }

    if (action === 'deadline_check') {
      const deadlineFacts = body.facts || {};
      const status = deadlineStatus({ ...deadlineFacts, track: deadlineFacts.track || inferTrack(deadlineFacts) }, body.now ? new Date(body.now) : new Date());
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, message: deadlineMessage(status) })
      };
    }

    if (action === 'intake_checkpoint') {
      const result = await saveIntakeCheckpoint({
        caseId: body.caseId || null,
        token: body.checkpointToken || null,
        facts: body.facts || {},
        events: body.events || []
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success:true, ...result })
      };
    }

    if (action === 'classify') {
      const result = await classifyText(body.text || '');
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
    }

    if (action === 'intake_turn') {
      const result = await processClientTurn({
        supabase,
        channel: body.channel || 'web',
        currentQuestion: body.currentQuestion || '',
        answer: body.answer || '',
        currentField: body.currentField || null,
        plannedNextQuestion: body.plannedNextQuestion || '',
        existingFacts: body.facts || {},
        promptCount: Number(body.promptCount || 0),
        promptLimit: Number(body.promptLimit || 0)
      });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
    }

    if (action === 'intake_handoff') {
      const facts = body.facts || {};
      const reason = String(body.reason || 'intake_incomplete');
      const missing = Array.isArray(body.missing) ? body.missing : [];
      const { data, error } = await supabase.from('cases').insert({
        client_name: facts.client_name || 'Intake follow-up required',
        contact_info: facts.contact_info || facts.whatsapp_number || null,
        issue_summary: 'Automated intake requires VRS follow-up before assessment can be completed.',
        case_facts: {
          ...facts,
          intake_handoff_reason: reason,
          intake_missing_fields: missing,
          attorney_review_flag: true,
          privacy_governance: facts.privacy_governance || retentionMetadata({ channel: facts.source || 'web' })
        },
        status: 'needs_more_info',
        letter_status: 'not_drafted'
      }).select().single();
      if (error) throw error;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          caseId: data.id,
          caseReference: data.client_reference || caseReference(data.id, data.created_at),
          message: 'Thanks. I have saved what you have told me and sent it to VRS so a person can continue with you.'
        })
      };
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
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, caseId: data.id, caseReference: data.client_reference || caseReference(data.id, data.created_at), triage, message: triage.recommended_next_step }) };
    }

    if (action === 'evaluate') {
      const originalFacts = body.facts || {};
      const initialStory = dedupeStory(`${originalFacts.initial_query ? `${originalFacts.initial_query} ` : ''}${originalFacts.incident_description || ''}`.trim());
      const governance = await classifyAndHydrateMatter({ narrative: initialStory, existingFacts: originalFacts });
      const facts = mergeGovernanceFacts(originalFacts, governance);
      const fullStory = dedupeStory(`${facts.initial_query ? `${facts.initial_query} ` : ''}${facts.incident_description || ''}`.trim());
      const contextText = await searchLegalContext(buildLegalKeywords(facts, fullStory));
      const scoringFacts = factsForDeterministicDecision(facts);
      const scoringStory = dedupeStory(
        facts.normalized_english_interpretation ||
        `${scoringFacts.initial_query ? `${scoringFacts.initial_query} ` : ''}${scoringFacts.incident_description || ''}`.trim()
      );
      const scoringInput = {
        ...scoringFacts,
        incident_description: scoringStory,
        original_client_narrative: fullStory,
        normalized_english_interpretation: facts.normalized_english_interpretation || null
      };
      const baseScorecard = scoreCase(scoringInput);
      const scorecard = applyOverridePostProcessing(scoringInput, scoringStory, baseScorecard);
      const determination = await explainDeterministicDetermination({
        facts,
        scorecard,
        sourceLinks: facts.verified_legal_sources || facts.legal_source_links || []
      });
      const preliminaryFacts = {
        ...buildCoreFacts(facts, fullStory, scorecard, contextText),
        fact_trace: buildFactTrace(facts),
        admin_determination: determination,
        recommended_forum: determination.forum || facts.recommended_forum || null
      };
      const caseFacts = {
        ...preliminaryFacts,
        product_route: determineProductRoute(preliminaryFacts)
      };
      const clientOutcome = clientOutcomeFor(caseFacts, scorecard);

      let data;
      const checkpointId = originalFacts._checkpoint_case_id || null;
      const checkpointToken = originalFacts._checkpoint_token || null;
      const evaluatedFacts = {
        ...caseFacts,
        client_outcome_message: clientOutcome,
        _intake_events: Array.isArray(originalFacts._intake_events) ? originalFacts._intake_events : undefined
      };

      if (checkpointId && checkpointToken) {
        const checkpoint = await readCheckpoint(checkpointId, checkpointToken);
        if (!checkpoint) throw new Error('Invalid intake checkpoint during evaluation');
        const prior = checkpoint.case_facts || {};
        const mergedFacts = {
          ...prior,
          ...cleanCheckpointFacts(evaluatedFacts),
          _intake_checkpoint: false,
          _intake_checkpoint_token_hash: prior._intake_checkpoint_token_hash,
          _intake_events: prior._intake_events || []
        };
        const { data: updated, error } = await supabase.from('cases').update({
          client_name: facts.client_name,
          contact_info: facts.whatsapp_number || facts.contact_info || facts.client_email || checkpoint.contact_info,
          issue_summary: fullStory || 'Gathered via automated intake.',
          case_facts: mergedFacts,
          status: 'new',
          letter_status: scorecard.wp_eligible ? 'not_drafted' : 'not_applicable',
          updated_at: new Date().toISOString()
        }).eq('id', checkpointId).select().single();
        if (error) throw error;
        data = updated;
      } else {
        const { data: inserted, error } = await supabase.from('cases').insert({
          client_name: facts.client_name,
          contact_info: facts.whatsapp_number || facts.contact_info || facts.client_email || null,
          issue_summary: fullStory || 'Gathered via automated intake.',
          case_facts: cleanCheckpointFacts(evaluatedFacts),
          status: 'new',
          letter_status: scorecard.wp_eligible ? 'not_drafted' : 'not_applicable'
        }).select().single();
        if (error) throw error;
        data = inserted;
      }

      let whatsapp = { linked: false, reason: 'not_web_intake' };
      if (facts.source === 'web' || facts.whatsapp_number) {
        try {
          whatsapp = await linkWebCaseToWhatsApp({ caseId: data.id, facts, caseFacts: { ...caseFacts, client_outcome_message: clientOutcome } });
          if (whatsapp.linked) {
            const normalisedFacts = { ...(data.case_facts || caseFacts), client_outcome_message: clientOutcome, contact_info: whatsapp.number, whatsapp_number: whatsapp.number, source: 'web' };
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

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pitch: clientOutcome, clientOutcome, internalAssessment: scorecard.advisory_note, hasMerit: scorecard.wp_eligible, caseId: data.id, caseReference: data.client_reference || caseReference(data.id, data.created_at), scorecard, governance: caseFacts.llm_governance, whatsapp }) };
    }

    if (action === 'close') {
      const { caseId, wants_letter, mandate_acceptance, payment_start_consent } = body;
      const { data: existing, error: readErr } = await supabase.from('cases').select('case_facts').eq('id', caseId).single();
      if (readErr) throw readErr;
      const caseFacts = existing?.case_facts || {};
      const wpEligible = caseFacts.wp_eligible === true && caseFacts.product_route?.wp_letter_allowed !== false;
      const updatePayload = {
        updated_at: new Date().toISOString(),
        case_facts: {
          ...caseFacts,
          wants_letter,
          ...(wants_letter && mandate_acceptance?.accepted === true ? { mandate_acceptance } : {}),
          ...(wants_letter && payment_start_consent?.accepted === true ? { payment_start_consent } : {})
        }
      };
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