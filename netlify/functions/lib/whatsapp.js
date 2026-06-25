async function sendWhatsAppText({ to, body, phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID }) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured');
  if (!to) throw new Error('Recipient WhatsApp number is required');
  if (!body) throw new Error('Message body is required');

  const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body
      }
    })
  });

  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { payload = { raw: text }; }

  if (!response.ok) {
    const message = payload?.error?.message || text || `WhatsApp send failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

module.exports = { sendWhatsAppText };