const { createClient } = require('@supabase/supabase-js');
const { withCaseReference } = require('./lib/caseReference');

const URL = process.env.SUPABASE_URL;
const USER_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function authenticate(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  if (!header.startsWith('Bearer ')) throw new Error('Unauthorized');
  const token = header.slice(7);
  const authClient = createClient(URL, USER_KEY, { global: { headers: { Authorization: 'Bearer ' + token } } });
  const { data: { user }, error } = await authClient.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return user;
}

function value(facts, ...keys) {
  for (const key of keys) {
    const v = facts?.[key];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function buildDiagnostics(row, conversation) {
  const f = row.case_facts || {};
  const meta = f._fact_metadata || {};
  const promptHistory = Array.isArray(f._intake_prompt_history) ? f._intake_prompt_history : [];
  const promptCount = Number(f._intake_prompt_count ?? promptHistory.length ?? 0);
  const deadline = f.ccma_deadline_status || f.admin_determination?.time_bar || {};
  const clientName = value(f, 'client_name') || row.client_name;
  const email = value(f, 'client_email', 'contact_email');
  const whatsapp = value(f, 'whatsapp_number') || (conversation?.from_number || null);
  const legacyContact = value(f, 'contact_info') || row.contact_info;
  const legalDate = value(f, 'incident_date', 'dismissal_date', 'resignation_date');
  const dateMeta = meta.incident_date || meta.dismissal_date || meta.resignation_date || null;
  const track = String(f.effective_decision?.track || f.admin_override?.track || f.track || '').toUpperCase();
  const flags = [];

  if (!clientName || /follow-up required|anonymous/i.test(String(clientName))) flags.push({ severity:'high', code:'CONTACT_NAME_MISSING', text:'Client name is missing or placeholder.' });
  if (!email) flags.push({ severity:'high', code:'CONTACT_EMAIL_MISSING', text:'Client email is missing.' });
  if (!whatsapp && !legacyContact) flags.push({ severity:'high', code:'CONTACT_PHONE_MISSING', text:'No WhatsApp/phone contact is stored.' });

  if (promptCount >= 15 || f.intake_handoff_reason === 'prompt_limit_incomplete' || f._prompt_limit_reason) {
    flags.push({ severity:'medium', code:'PROMPT_CAP_REACHED', text:'The intake reached the substantive prompt cap.' });
  }
  if (f.intake_handoff_reason === 'prompt_limit_incomplete') {
    flags.push({ severity:'high', code:'OLD_PROMPT_LIMIT_HANDOFF', text:'This case was hard-stopped by the old 15-prompt handoff behaviour.' });
  }

  if (!legalDate && ['UD-MISCONDUCT','UD-POOR_PERFORMANCE','UD-INCAPACITY','UD-RETRENCHMENT','CD','AUD'].includes(track)) {
    flags.push({ severity:'high', code:'LEGAL_DATE_MISSING', text:'No confirmed legal event date is stored for a dismissal/resignation track.' });
  }
  if (legalDate && dateMeta?.source === 'initial_narrative_ai' && dateMeta.confirmed !== true) {
    flags.push({ severity:'high', code:'AI_DATE_UNCONFIRMED', text:'The legal date came from AI extraction and is not client-confirmed.' });
  }
  if (legalDate && dateMeta?.source === 'initial_narrative_ai' && dateMeta.trust_basis === 'high_confidence_initial_narrative') {
    flags.push({ severity:'high', code:'LEGACY_AI_DATE_AUTO_CONFIRMED', text:'Legacy intake auto-confirmed an AI-extracted legal date.' });
  }

  const deadlineStatus = String(deadline.status || '').toUpperCase();
  if (deadlineStatus === 'LAPSED-CONDONATION') flags.push({ severity:'critical', code:'DEADLINE_LAPSED', text:'Ordinary CCMA referral period appears lapsed; condonation may be required.' });
  if (deadlineStatus === 'UNKNOWN' || (!deadlineStatus && ['UD-MISCONDUCT','UD-POOR_PERFORMANCE','UD-INCAPACITY','UD-RETRENCHMENT','CD','AUD'].includes(track))) {
    flags.push({ severity:'high', code:'DEADLINE_UNKNOWN', text:'CCMA deadline could not be confirmed.' });
  }
  if (deadlineStatus === 'WITHIN_WINDOW' && Number(deadline.daysRemaining ?? deadline.days_left) <= 7) {
    flags.push({ severity:'critical', code:'DEADLINE_URGENT', text:'Seven days or fewer remain in the ordinary referral period.' });
  }

  if (track === 'UD-POOR_PERFORMANCE' && f.effective_decision?.track && f.effective_decision.track !== 'UD-POOR_PERFORMANCE') {
    flags.push({ severity:'medium', code:'PERFORMANCE_OVERRIDE_MISMATCH', text:'Original poor-performance track differs from effective override.' });
  }

  if (f.wp_eligible === true && f.mandate_acceptance?.accepted !== true && !whatsapp && !conversation?.from_number) {
    flags.push({ severity:'high', code:'MANDATE_NO_CHANNEL', text:'Mandate is outstanding and there is no WhatsApp channel to request it.' });
  }
  if (conversation?.error_message) flags.push({ severity:'high', code:'WHATSAPP_ERROR', text:conversation.error_message });
  if (conversation?.handoff_reason) flags.push({ severity:'medium', code:'WHATSAPP_HANDOFF', text:'WhatsApp handoff: ' + conversation.handoff_reason });

  return {
    contact: { client_name: clientName, client_email: email, whatsapp_number: whatsapp, legacy_contact: legacyContact },
    intake: {
      source: f.source || (conversation ? 'whatsapp' : null),
      prompt_count: promptCount,
      prompt_history: promptHistory,
      prompt_limit_reason: f._prompt_limit_reason || f.intake_handoff_reason || null,
      missing_fields_at_handoff: f.intake_missing_fields || [],
      original_client_narrative: f.original_client_narrative || f.initial_query || null,
      normalized_english_interpretation: f.normalized_english_interpretation || null
    },
    dates: {
      legal_date: legalDate,
      metadata: dateMeta,
      ccma_deadline_status: f.ccma_deadline_status || null,
      determination_time_bar: f.admin_determination?.time_bar || null
    },
    decision: {
      track: f.track || null,
      effective_track: f.effective_decision?.track || f.admin_override?.track || f.track || null,
      dismissal_reason_type: f.dismissal_reason_type || null,
      merit_band: f.effective_decision?.merit_band || f.merit_band || null,
      wp_eligible: f.effective_decision?.wp_eligible ?? f.wp_eligible ?? null,
      client_outcome_message: f.client_outcome_message || null,
      product_route: f.product_route || null
    },
    progression: {
      case_status: row.status,
      letter_status: row.letter_status,
      payment_status: row.payment_status,
      paid_at: row.paid_at || null,
      mandate_acceptance: f.mandate_acceptance || null,
      mandate_requested_at: f.mandate_requested_at || null,
      payment_start_consent: f.payment_start_consent || null,
      payment_consent_requested_at: f.payment_consent_requested_at || null,
      wants_letter: f.wants_letter ?? null
    },
    provenance: {
      fact_metadata: meta,
      fact_trace: f.fact_trace || f.admin_determination?.fact_trace || [],
      llm_governance: f.llm_governance || null,
      llm_call_logs: f.llm_call_logs || []
    },
    whatsapp: conversation ? {
      id: conversation.id,
      from_number: conversation.from_number,
      contact_name: conversation.contact_name,
      current_step: conversation.current_step,
      status: conversation.status,
      classification: conversation.classification,
      collected_facts: conversation.collected_facts,
      processed_message_count: Array.isArray(conversation.processed_message_ids) ? conversation.processed_message_ids.length : 0,
      processed_message_ids: conversation.processed_message_ids || [],
      last_inbound_at: conversation.last_inbound_at,
      last_outbound_at: conversation.last_outbound_at,
      handoff_reason: conversation.handoff_reason,
      error_message: conversation.error_message,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at
    } : null,
    flags
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error:'Method Not Allowed' });
  try {
    const user = await authenticate(event);
    const service = createClient(URL, SERVICE_KEY);
    const params = event.queryStringParameters || {};
    const caseId = params.caseId || null;
    const q = String(params.q || '').trim().toLowerCase();

    let query = service.from('cases').select('*').order('updated_at', { ascending:false });
    if (caseId) query = query.eq('id', caseId);
    else query = query.limit(100);
    const { data: cases, error } = await query;
    if (error) throw error;

    const ids = (cases || []).map(x => x.id);
    let conversations = [];
    if (ids.length) {
      const { data, error: convError } = await service
        .from('whatsapp_conversations')
        .select('*')
        .in('case_id', ids);
      if (convError) throw convError;
      conversations = data || [];
    }
    const byCase = new Map(conversations.map(x => [x.case_id, x]));

    let items = (cases || []).map(raw => {
      const row = withCaseReference(raw);
      const f = row.case_facts || {};
      const conversation = byCase.get(row.id) || null;
      const diagnostics = buildDiagnostics(row, conversation);
      return {
        id: row.id,
        case_reference: row.case_reference,
        client_reference: row.client_reference || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        client_name: f.client_name || row.client_name || null,
        employer_name: f.employer_name || null,
        status: row.status,
        letter_status: row.letter_status,
        payment_status: row.payment_status,
        track: diagnostics.decision.effective_track,
        flags: diagnostics.flags,
        ...(caseId ? { raw_case: row, review: diagnostics } : {})
      };
    });

    if (q && !caseId) {
      items = items.filter(item => JSON.stringify(item).toLowerCase().includes(q));
    }

    return json(200, {
      authenticated_as: user.email || user.id,
      transcript_warning: 'Web intake does not retain a verbatim per-turn transcript. WhatsApp conversation state retains message IDs and facts, not inbound/outbound message bodies. This harness reviews persisted audit/state data only.',
      count: items.length,
      items
    });
  } catch (error) {
    return json(error.message === 'Unauthorized' ? 401 : 500, { error:error.message });
  }
};
