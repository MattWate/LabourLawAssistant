const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppText } = require('./lib/whatsapp');

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
          text_body: message.text?.body || null,
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
      processing_result: processing
    }).select().single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn('WhatsApp webhook logging skipped:', error.message);
    return null;
  }
}

function justineReply(message = {}) {
  const text = String(message.text_body || '').trim();
  if (!text) return 'Thanks for contacting VRS. I can currently receive text messages only. Please send a short description of the labour-law issue you need help with.';

  return 'Hi, I am Justine, the VRS Labour Law Assistant. I have received your message. Please reply with a short summary of what happened, including whether you were dismissed, resigned or are still employed. A VRS team member will be able to review the intake from the dashboard.';
}

async function replyToIncomingMessages(messages = []) {
  const results = [];
  const incoming = messages.filter(item => item.type === 'message' && item.from_number && item.message_type === 'text');

  for (const message of incoming) {
    try {
      const result = await sendWhatsAppText({
        to: message.from_number,
        phoneNumberId: message.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
        body: justineReply(message)
      });
      results.push({ to: message.from_number, ok: true, result });
    } catch (error) {
      console.warn('WhatsApp reply failed:', error.message);
      results.push({ to: message.from_number, ok: false, error: error.message });
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
    await persistWebhookEvent(payload, extracted, {
      processed: true,
      reply_results: replyResults,
      auto_reply_enabled: process.env.WHATSAPP_AUTO_REPLY !== 'false'
    });

    console.log('WhatsApp webhook received', {
      object: payload.object,
      eventCount: extracted.length,
      eventTypes: extracted.map(item => item.type),
      replies: replyResults.length
    });

    return response(200, { ok: true, received: true, events: extracted.length, replies: replyResults.length });
  }

  return response(405, { ok: false, error: 'Method Not Allowed' });
};