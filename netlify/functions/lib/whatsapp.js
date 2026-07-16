const DEFAULT_GRAPH_VERSION = 'v20.0';

function graphVersion() {
  const value = String(process.env.WHATSAPP_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).trim();
  return value.startsWith('v') ? value : `v${value}`;
}

async function postWhatsAppMessage({ to, payload, phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID }) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured');
  if (!to) throw new Error('Recipient WhatsApp number is required');
  if (!payload) throw new Error('WhatsApp message payload is required');

  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...payload
    })
  });

  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch (error) { result = { raw: text }; }

  if (!response.ok) {
    const message = result?.error?.message || text || `WhatsApp send failed with status ${response.status}`;
    throw new Error(message);
  }

  return result;
}

async function sendWhatsAppText({ to, body, phoneNumberId }) {
  if (!body) throw new Error('Message body is required');
  return postWhatsAppMessage({
    to,
    phoneNumberId,
    payload: {
      type: 'text',
      text: { preview_url: false, body }
    }
  });
}

async function sendWhatsAppButtons({ to, body, buttons, phoneNumberId, footer }) {
  if (!body) throw new Error('Interactive message body is required');
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) {
    throw new Error('WhatsApp reply buttons require between 1 and 3 buttons');
  }

  return postWhatsAppMessage({
    to,
    phoneNumberId,
    payload: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
        action: {
          buttons: buttons.map((button, index) => ({
            type: 'reply',
            reply: {
              id: String(button.id || `choice:${index + 1}`).slice(0, 256),
              title: String(button.title || `Option ${index + 1}`).slice(0, 20)
            }
          }))
        }
      }
    }
  });
}

async function sendWhatsAppList({ to, body, rows, phoneNumberId, buttonText = 'Choose an option', sectionTitle = 'Options', footer }) {
  if (!body) throw new Error('Interactive list body is required');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10) {
    throw new Error('WhatsApp lists require between 1 and 10 rows');
  }

  return postWhatsAppMessage({
    to,
    phoneNumberId,
    payload: {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body.slice(0, 1024) },
        ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
        action: {
          button: buttonText.slice(0, 20),
          sections: [{
            title: sectionTitle.slice(0, 24),
            rows: rows.map((row, index) => ({
              id: String(row.id || `choice:${index + 1}`).slice(0, 200),
              title: String(row.title || `Option ${index + 1}`).slice(0, 24),
              ...(row.description ? { description: String(row.description).slice(0, 72) } : {})
            }))
          }]
        }
      }
    }
  });
}

module.exports = {
  postWhatsAppMessage,
  sendWhatsAppText,
  sendWhatsAppButtons,
  sendWhatsAppList
};