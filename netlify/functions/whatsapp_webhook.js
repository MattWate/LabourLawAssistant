const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList } = require('./lib/whatsapp');
const { processIncomingMessage, STEPS } = require('./lib/whatsappConversation');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-hub-signature-256',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function response(statusCode, body, headers = jsonHeaders) {
  return {
    statusCode,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

function parseJson(body = '{}') {
  try {
    return JSON.parse(body || '{}');
  } catch (error) {
    return null;
  }
}

function extractInteractiveAnswer(message = {}) {
  const reply = message.interactive?.button_reply || message.interactive?.list_reply;
  if (!reply) return null;

  const id = String(reply.id || '').trim();
  const choiceMatch = id.match(/^choice:(\d+)$/i);
  if (choiceMatch) return choiceMatch[1];

  return reply.title || id || null;
}

function extractMessages(payload = {}) {
  const messages = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change.value || {};
      const metadata = value.metadata || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const incoming = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];

      incoming.forEach(message => {
        const contact = contacts.find(item => item.wa_id === message.from) || contacts[0] || {};
        messages.push({
          type: 'message',
          whatsapp_message_id: message.id || null,
          from_number: message.from || null,
          contact_name: contact.profile?.name || null,
          phone_number_id: metadata.phone_number_id || null,
          display_phone_number: metadata.display_phone_number || null,
          timestamp: message.timestamp || null,
          message_type: message.type || null,
          text_body: message.text?.body || extractInteractiveAnswer(message),
          interactive_reply: message.interactive?.button_reply || message.interactive?.list_reply || null,
          raw_message: message,
          raw_change: change
        });
      });

      statuses.forEach(status => {
        messages.push({
          type: 'status',
          whatsapp_message_id: status.id || null,
          from_number: status.recipient_id || null,
          phone_number_id: metadata.phone_number_id || null,
          display_phone_number: metadata.display_phone_number || null,
          timestamp: status.timestamp || null,
          status: status.status || null,
          raw_message: status,
          raw_change: change
        });
      });
    }
  }

  return messages;
}

async function persistWebhookEvent(payload, extracted, processing = {}) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.from('whatsapp_webhook_events').insert({
      event_type: extracted.length ? extracted.map(item => item.type).join(',') : 'unknown',
      from_number: extracted.find(item => item.from_number)?.from_number || null,
      phone_number_id: extracted.find(item => item.phone_number_id)?.phone_number_id || null,
      payload,
      extracted_messages: extracted,
      processed: processing.processed || false,
      processed_at: processing.processed ? new Date().toISOString() : null,
      processing_error: processing.processing_error || null,
      processing_result: processing
    }).select().single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn('WhatsApp webhook logging skipped:', error.message);
    return null;
  }
}

async function getConversation(fromNumber) {
  if (!supabase || !fromNumber) return null;
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('current_step,status')
    .eq('from_number', fromNumber)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function cleanInteractiveBody(body, step) {
  const value = String(body || '').trim();
  if (!step?.prompt) return value;
  const promptIndex = value.indexOf(step.prompt);
  if (promptIndex === -1) return step.prompt;
  return `${value.slice(0, promptIndex)}${step.prompt}`.trim();
}

async function sendJustineReply(message, body) {
  const phoneNumberId = message.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const conversation = await getConversation(message.from_number);
  const step = conversation?.status === 'active' ? STEPS[conversation.current_step] : null;

  if (step?.type === 'buttons' && Array.isArray(step.choices)) {
    const interactiveBody = cleanInteractiveBody(body, step);
    const footer = 'You can also type a number.';

    if (step.choices.length <= 3 && step.choices.every(item => String(item.label).length <= 20)) {
      return sendWhatsAppButtons({
        to: message.from_number,
        phoneNumberId,
        body: interactiveBody,
        footer,
        buttons: step.choices.map((item, index) => ({
          id: `choice:${index + 1}`,
          title: item.label
        }))
      });
    }

    if (step.choices.length <= 10) {
      return sendWhatsAppList({
        to: message.from_number,
        phoneNumberId,
        body: interactiveBody,
        footer,
        buttonText: 'Choose an option',
        rows: step.choices.map((item, index) => ({
          id: `choice:${index + 1}`,
          title: item.label,
          description: `Option ${index + 1}`
        }))
      });
    }
  }

  return sendWhatsAppText({
    to: message.from_number,
    phoneNumberId,
    body
  });
}

async function replyToIncomingMessages(messages = []) {
  const results = [];
  const incoming = messages.filter(item => item.type === 'message' && item.from_number);

  for (const message of incoming) {
    try {
      let body;
      if (!['text', 'interactive'].includes(message.message_type) || !message.text_body) {
        body = 'I can currently process text answers, reply buttons and list selections. Please type your answer or select one of the options shown.';
      } else {
        body = await processIncomingMessage(message);
      }

      if (!body) {
        results.push({ to: message.from_number, ok: true, duplicate: true, skipped: true });
        continue;
      }

      const result = await sendJustineReply(message, body);
      results.push({ to: message.from_number, ok: true, result });
    } catch (error) {
      console.error('WhatsApp intake failed:', {
        to: message.from_number,
        messageId: message.whatsapp_message_id,
        error: error.message,
        stack: error.stack
      });
      results.push({ to: message.from_number, ok: false, error: error.message });

      try {
        await sendWhatsAppText({
          to: message.from_number,
          phoneNumberId: message.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
          body: 'I am sorry, I could not process that message. Your message has been logged. Please type RESTART to try again or HELP for assistance from the VRS team.'
        });
      } catch (sendError) {
        console.warn('WhatsApp recovery reply failed:', sendError.message);
      }
    }
  }

  return results;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, { ok: true });

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (!expectedToken) {
      console.error('WHATSAPP_VERIFY_TOKEN is not configured.');
      return response(500, 'Webhook verification token is not configured.', { 'Content-Type': 'text/plain' });
    }

    if (mode === 'subscribe' && token === expectedToken && challenge) {
      return response(200, challenge, { 'Content-Type': 'text/plain' });
    }

    return response(403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  if (event.httpMethod === 'POST') {
    const payload = parseJson(event.body);
    if (!payload) return response(400, { ok: false, error: 'Invalid JSON payload' });

    const extracted = extractMessages(payload);
    const replyResults = process.env.WHATSAPP_AUTO_REPLY === 'false' ? [] : await replyToIncomingMessages(extracted);
    const failed = replyResults.filter(item => !item.ok);

    await persistWebhookEvent(payload, extracted, {
      processed: failed.length === 0,
      processing_error: failed.length ? failed.map(item => item.error).join('; ') : null,
      reply_results: replyResults,
      auto_reply_enabled: process.env.WHATSAPP_AUTO_REPLY !== 'false'
    });

    console.log('WhatsApp webhook received', {
      object: payload.object,
      eventCount: extracted.length,
      eventTypes: extracted.map(item => item.type),
      replies: replyResults.length,
      failures: failed.length
    });

    return response(200, {
      ok: failed.length === 0,
      received: true,
      events: extracted.length,
      replies: replyResults.length,
      failures: failed.length
    });
  }

  return response(405, { ok: false, error: 'Method Not Allowed' });
};