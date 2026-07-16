const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const INTRO = `Hi, I am Justine, the VRS Labour Law Assistant. I will ask a few questions to understand your situation and prepare it for review by the VRS legal team.\n\nMy automated assessment is not a substitute for advice from a qualified attorney. You can type HELP at any time to request human assistance, or RESTART to begin again.`;

const STEPS = {
  JUR_EMPLOYEE: {
    prompt: `Are you an employee rather than an independent contractor?\n\n1. Yes\n2. No\n3. Unsure`,
    saveAs: 'worker_status',
    choices: {
      yes: { value: 'Employee', next: 'JUR_SA_EMPLOYER' },
      no: { value: 'Contractor', next: 'JUR_CONTRACTOR_CONTROL' },
      unsure: { value: 'Unsure', next: 'JUR_CONTRACTOR_CONTROL' }
    }
  },
  JUR_CONTRACTOR_CONTROL: {
    prompt: `Does someone tell you when to start work, when to stop work and how to do the work?\n\n1. Yes\n2. No`,
    saveAs: 'contractor_control_test',
    choices: {
      yes: { value: 'yes', next: 'JUR_SA_EMPLOYER' },
      no: { value: 'no', next: 'DEFLECT_CONTRACTOR' }
    }
  },
  JUR_SA_EMPLOYER: {
    prompt: `Is your employer registered in South Africa or operating in South Africa?\n\n1. Yes\n2. No\n3. Unsure`,
    saveAs: 'south_african_employer',
    choices: {
      yes: { value: 'yes', next: 'JUR_PUBLIC_SERVICE' },
      no: { value: 'no', next: 'DEFLECT_CROSS_BORDER' },
      unsure: { value: 'unsure', next: 'JUR_PUBLIC_SERVICE' }
    }
  },
  JUR_PUBLIC_SERVICE: {
    prompt: `Are you employed under the Public Service Act, or by a government agency such as SAPS, SANDF, a national or provincial department?\n\n1. Yes\n2. No\n3. Unsure`,
    saveAs: 'public_service_or_excluded_agency',
    choices: {
      yes: { value: 'yes', next: 'DEFLECT_PUBLIC_SERVICE' },
      no: { value: 'no', next: 'START' },
      unsure: { value: 'unsure', next: 'JUR_SOE' }
    }
  },
  JUR_SOE: {
    prompt: `Are you employed by a state-owned enterprise and do you know whether your dispute may be referred to the CCMA?\n\n1. Yes\n2. No\n3. Unsure`,
    saveAs: 'schedule_2_soe_ccma_eligible',
    choices: {
      yes: { value: 'yes', next: 'START' },
      no: { value: 'no', next: 'START' },
      unsure: { value: 'unclear', next: 'DEFLECT_SOE_UNCLEAR' }
    }
  },
  START: {
    prompt: `Please briefly describe the work issue in your own words. Include whether you were dismissed, resigned, are still employed, or need help with UIF, and tell me what happened.`,
    type: 'narrative'
  }
};

const DEFLECTIONS = {
  DEFLECT_CONTRACTOR: 'Your answers suggest that you may be an independent contractor rather than an employee. This may fall outside the normal CCMA process. I have recorded your enquiry for a VRS team member to review.',
  DEFLECT_CROSS_BORDER: 'Your matter may involve cross-border jurisdiction. I have recorded your enquiry so that a VRS team member can confirm the correct legal forum.',
  DEFLECT_PUBLIC_SERVICE: 'Public-service disputes may need to follow a bargaining council or specialised grievance process. I have recorded your enquiry for review by the VRS team.',
  DEFLECT_SOE_UNCLEAR: 'The correct forum for a state-owned enterprise employee depends on the employer and dispute. I have recorded your enquiry for a VRS team member to confirm jurisdiction.'
};

function cleanText(value = '') {
  return String(value || '').trim();
}

function normalizeChoice(value = '', step) {
  const text = cleanText(value).toLowerCase().replace(/[.!?]/g, '').trim();
  const yesTerms = ['1', 'yes', 'y', 'yeah', 'yep', 'correct', 'employee', 'i am', 'i am an employee'];
  const noTerms = ['2', 'no', 'n', 'nope', 'contractor', 'independent contractor'];
  const unsureTerms = ['3', 'unsure', 'not sure', 'i dont know', "i don't know", 'unclear', 'maybe'];

  if (yesTerms.includes(text) || text.startsWith('yes ')) return 'yes';
  if (noTerms.includes(text) || text.startsWith('no ')) return 'no';
  if (unsureTerms.includes(text)) return 'unsure';

  if (step === 'JUR_CONTRACTOR_CONTROL' && text === '2') return 'no';
  return null;
}

function nextPrompt(step) {
  return STEPS[step]?.prompt || null;
}

async function invokeAsk(action, payload) {
  const { handler } = require('../ask');
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action, ...payload })
  });
  const body = JSON.parse(result.body || '{}');
  if (result.statusCode >= 400) throw new Error(body.error || body.message || `Assessment request failed with status ${result.statusCode}`);
  return body;
}

async function getConversation(fromNumber) {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('from_number', fromNumber)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createConversation(message) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .insert({
      from_number: message.from_number,
      contact_name: message.contact_name || null,
      phone_number_id: message.phone_number_id || null,
      current_step: 'JUR_EMPLOYEE',
      status: 'active',
      collected_facts: {
        client_name: message.contact_name || null,
        contact_info: message.from_number,
        source: 'whatsapp'
      },
      processed_message_ids: message.whatsapp_message_id ? [message.whatsapp_message_id] : [],
      last_inbound_at: now,
      updated_at: now
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateConversation(id, patch) {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

function appendMessageId(conversation, messageId) {
  const ids = Array.isArray(conversation.processed_message_ids) ? conversation.processed_message_ids : [];
  if (!messageId || ids.includes(messageId)) return ids;
  return [...ids.slice(-49), messageId];
}

async function markHandoff(conversation, message, reason, facts = {}) {
  const issueSummary = DEFLECTIONS[reason] || 'WhatsApp intake requires human review.';
  const { data: caseRow, error: caseError } = await supabase
    .from('cases')
    .insert({
      client_name: facts.client_name || conversation.contact_name || 'WhatsApp enquiry',
      contact_info: conversation.from_number,
      issue_summary: issueSummary,
      case_facts: {
        ...facts,
        source: 'whatsapp',
        jurisdiction_outcome: reason,
        attorney_review_flag: true
      },
      status: 'jurisdiction_triage',
      letter_status: 'not_applicable'
    })
    .select()
    .single();
  if (caseError) throw caseError;

  await updateConversation(conversation.id, {
    status: 'handoff',
    current_step: reason,
    handoff_reason: reason,
    case_id: caseRow.id,
    collected_facts: facts,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
    last_inbound_at: new Date().toISOString()
  });

  return `${issueSummary}\n\nReference: ${caseRow.id}`;
}

async function restartConversation(conversation, message) {
  const facts = {
    client_name: message.contact_name || conversation.contact_name || null,
    contact_info: message.from_number,
    source: 'whatsapp'
  };
  await updateConversation(conversation.id, {
    current_step: 'JUR_EMPLOYEE',
    status: 'active',
    collected_facts: facts,
    classification: null,
    case_id: null,
    handoff_reason: null,
    error_message: null,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
    last_inbound_at: new Date().toISOString()
  });
  return `${INTRO}\n\n${nextPrompt('JUR_EMPLOYEE')}`;
}

async function completeNarrative(conversation, message, narrative) {
  const existingFacts = conversation.collected_facts || {};
  const classification = await invokeAsk('classify', { text: narrative });
  const category = classification.category || classification.employment_status || 'Ambiguous';
  const facts = {
    ...existingFacts,
    initial_query: narrative,
    incident_description: narrative,
    employment_status: category,
    dismissal_reason_type: classification.dismissal_reason_type || null,
    advisory_topic: classification.advisory_topic || null,
    contact_info: conversation.from_number,
    client_name: existingFacts.client_name || conversation.contact_name || null,
    source: 'whatsapp'
  };

  const evaluation = await invokeAsk('evaluate', { facts });
  await updateConversation(conversation.id, {
    status: 'completed',
    current_step: 'COMPLETE',
    collected_facts: facts,
    classification,
    case_id: evaluation.caseId,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
    last_inbound_at: new Date().toISOString()
  });

  const assessment = evaluation.pitch || evaluation.scorecard?.recommended_next_step || 'Your enquiry has been recorded for review.';
  return `Thank you. I have created your confidential VRS intake and sent it for legal review.\n\nInitial assessment:\n${assessment}\n\nYour reference is ${evaluation.caseId}. A VRS team member can now review the full matter.`;
}

async function processIncomingMessage(message) {
  if (!supabase) throw new Error('Supabase is not configured for WhatsApp conversation state');
  const text = cleanText(message.text_body);
  if (!text) return 'I can currently process text messages only. Please type a short response.';

  let conversation = await getConversation(message.from_number);
  if (!conversation) {
    await createConversation(message);
    return `${INTRO}\n\n${nextPrompt('JUR_EMPLOYEE')}`;
  }

  const processedIds = Array.isArray(conversation.processed_message_ids) ? conversation.processed_message_ids : [];
  if (message.whatsapp_message_id && processedIds.includes(message.whatsapp_message_id)) return null;

  const command = text.toLowerCase();
  if (['restart', 'start again', 'reset'].includes(command)) return restartConversation(conversation, message);
  if (['help', 'human', 'agent', 'attorney', 'lawyer'].includes(command)) {
    return markHandoff(conversation, message, 'USER_REQUESTED_HELP', conversation.collected_facts || {});
  }

  if (conversation.status === 'completed') {
    return 'Your intake has already been submitted. Type RESTART to begin a new matter, or HELP to request assistance from the VRS team.';
  }
  if (conversation.status === 'handoff') {
    return 'Your enquiry is already waiting for human review. Type RESTART only if you need to submit a different matter.';
  }

  const step = conversation.current_step || 'JUR_EMPLOYEE';
  if (step === 'START') return completeNarrative(conversation, message, text);

  const definition = STEPS[step];
  if (!definition) return restartConversation(conversation, message);

  const normalized = normalizeChoice(text, step);
  const choice = normalized ? definition.choices?.[normalized] : null;
  if (!choice) return `I did not understand that answer. Please reply using the number or wording shown.\n\n${definition.prompt}`;

  const facts = { ...(conversation.collected_facts || {}), [definition.saveAs]: choice.value };
  if (DEFLECTIONS[choice.next]) return markHandoff(conversation, message, choice.next, facts);

  await updateConversation(conversation.id, {
    current_step: choice.next,
    collected_facts: facts,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
    last_inbound_at: new Date().toISOString()
  });

  return nextPrompt(choice.next);
}

module.exports = { processIncomingMessage, STEPS };
