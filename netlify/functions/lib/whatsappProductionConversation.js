const { createClient } = require('@supabase/supabase-js');
const baseConversation = require('./whatsappConversation');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const CLIENT_EMAIL_PROMPT = 'What email address should VRS use to contact you and copy you on any approved letter sent to your employer?';
const COMPLETION_MESSAGE = 'Thank you. Your information has been submitted securely to VRS. A VRS lawyer will review the details and Justine’s initial assessment. You will receive feedback soon confirming whether your matter has sufficient merit and whether you are eligible for a formal letter to your employer.';
const INFO_REPLY_CONFIRMATION = 'Thank you. I have added your response to your case and notified the VRS legal team for review.';

function clean(value = '') {
  return String(value || '').trim();
}

function validEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}

async function getConversation(fromNumber) {
  if (!supabase) throw new Error('Supabase is not configured for WhatsApp conversation state');
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('from_number', fromNumber)
    .maybeSingle();
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

async function invokeAsk(action, payload) {
  const { handler } = require('../ask');
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ action, ...payload }) });
  const body = JSON.parse(result.body || '{}');
  if (result.statusCode >= 400) throw new Error(body.error || body.message || `Assessment failed with status ${result.statusCode}`);
  return body;
}

async function completeAfterEmail(conversation, message, email) {
  const facts = {
    ...(conversation.collected_facts || {}),
    client_email: email,
    contact_info: conversation.from_number,
    source: 'whatsapp'
  };

  const evaluation = await invokeAsk('evaluate', { facts });
  await updateConversation(conversation.id, {
    status: 'completed',
    current_step: 'COMPLETE',
    collected_facts: facts,
    case_id: evaluation.caseId,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
    last_inbound_at: new Date().toISOString()
  });

  return COMPLETION_MESSAGE;
}

async function capturePendingInfoReply(conversation, message) {
  if (!conversation?.case_id || !message?.text_body) return null;

  const { data: caseData, error } = await supabase
    .from('cases')
    .select('id,status,case_facts')
    .eq('id', conversation.case_id)
    .maybeSingle();
  if (error) throw error;
  if (!caseData) return null;

  const facts = caseData.case_facts || {};
  const questions = Array.isArray(facts.client_questions) ? [...facts.client_questions] : [];
  let pendingIndex = -1;
  for (let i = questions.length - 1; i >= 0; i -= 1) {
    if (questions[i]?.status === 'pending' && questions[i]?.channel === 'whatsapp') {
      pendingIndex = i;
      break;
    }
  }
  if (pendingIndex === -1) return null;

  const answer = clean(message.text_body);
  if (!answer) return 'Please type your answer to the VRS legal team’s question.';

  const now = new Date().toISOString();
  const pending = { ...questions[pendingIndex] };
  questions[pendingIndex] = {
    ...pending,
    status: 'answered',
    answer,
    answered_at: now,
    answer_channel: 'whatsapp',
    answer_message_id: message.whatsapp_message_id || null
  };

  const remainingPending = questions.some(item => item?.status === 'pending');
  const returnStatus = remainingPending ? 'needs_more_info' : (pending.return_status || 'requires_attorney');

  const { error: updateError } = await supabase.from('cases').update({
    status: returnStatus,
    case_facts: {
      ...facts,
      client_questions: questions,
      client_answer_received_at: now,
      attorney_review_flag: true
    },
    updated_at: now
  }).eq('id', caseData.id);
  if (updateError) throw updateError;

  await updateConversation(conversation.id, {
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
    last_inbound_at: now
  });

  return INFO_REPLY_CONFIRMATION;
}

async function processIncomingMessage(message) {
  const conversation = await getConversation(message.from_number);

  if (conversation && Array.isArray(conversation.processed_message_ids) && message.whatsapp_message_id && conversation.processed_message_ids.includes(message.whatsapp_message_id)) {
    return null;
  }

  const pendingInfoReply = await capturePendingInfoReply(conversation, message);
  if (pendingInfoReply) return pendingInfoReply;

  if (conversation?.current_step === 'CLIENT_PHONE' && conversation.status === 'active') {
    const input = clean(message.text_body);
    if (!input) return 'Please provide the best cell phone number to reach you on.';

    const facts = {
      ...(conversation.collected_facts || {}),
      contact_info: input,
      whatsapp_number: message.from_number
    };

    await updateConversation(conversation.id, {
      current_step: 'CLIENT_EMAIL',
      collected_facts: facts,
      processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id),
      last_inbound_at: new Date().toISOString()
    });

    return CLIENT_EMAIL_PROMPT;
  }

  if (conversation?.current_step === 'CLIENT_EMAIL' && conversation.status === 'active') {
    const email = clean(message.text_body).toLowerCase();
    if (!validEmail(email)) {
      return `That does not look like a valid email address. Please enter an address such as name@example.com.\n\n${CLIENT_EMAIL_PROMPT}`;
    }
    return completeAfterEmail(conversation, message, email);
  }

  const result = await baseConversation.processIncomingMessage(message);

  // Older completed conversations may still receive the original detailed assessment.
  // Replace it with the production client-facing confirmation without changing saved legal analysis.
  if (typeof result === 'string' && /Initial assessment:|Reference:/i.test(result) && /confidential VRS intake/i.test(result)) {
    return COMPLETION_MESSAGE;
  }

  return result;
}

module.exports = {
  processIncomingMessage,
  STEPS: {
    ...baseConversation.STEPS,
    CLIENT_EMAIL: { type: 'text', prompt: CLIENT_EMAIL_PROMPT, saveAs: 'client_email', next: 'HANDOFF' }
  },
  CLIENT_EMAIL_PROMPT,
  COMPLETION_MESSAGE,
  INFO_REPLY_CONFIRMATION
};
