function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function letterToHtml(letter = '') {
  return `<div style="font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#172033;line-height:1.6">
    <div style="white-space:pre-wrap">${escapeHtml(letter)}</div>
  </div>`;
}

async function sendEmail({ to, cc = [], subject, html, text }) {
  const apiKey = required('RESEND_API_KEY');
  const from = required('EMAIL_FROM');
  if (!to) throw new Error('Email recipient is required');
  if (!subject) throw new Error('Email subject is required');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      ...(Array.isArray(cc) && cc.length ? { cc } : {}),
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {})
    })
  });

  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch (error) { body = { raw }; }
  if (!response.ok) throw new Error(body?.message || raw || `Email send failed with status ${response.status}`);
  return body;
}

async function sendApprovedLetter({ employerEmail, clientEmail, clientName, employerName, letter, caseId }) {
  const subject = `Formal correspondence regarding ${clientName || 'VRS client'}${employerName ? ` — ${employerName}` : ''}`;
  const intro = `<p>Please find below formal correspondence issued in relation to the employment matter referenced ${escapeHtml(caseId)}.</p>`;
  const outro = '<p>Regards,<br>VRS Labour Law</p>';
  return sendEmail({
    to: employerEmail,
    cc: clientEmail ? [clientEmail] : [],
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#172033;line-height:1.6">${intro}${letterToHtml(letter)}${outro}</div>`,
    text: `Please find formal correspondence below.\n\n${letter}\n\nRegards,\nVRS Labour Law`
  });
}

module.exports = { sendEmail, sendApprovedLetter, letterToHtml };