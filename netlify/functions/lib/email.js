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

function normaliseAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).filter(Boolean).map(item => ({
    filename: item.filename,
    content: Buffer.isBuffer(item.content) ? item.content.toString('base64') : item.content,
    ...(item.contentType ? { content_type: item.contentType } : {})
  }));
}

async function sendEmail({ to, cc = [], subject, html, text, attachments = [] }) {
  const apiKey = required('RESEND_API_KEY');
  const from = required('EMAIL_FROM');
  if (!to) throw new Error('Email recipient is required');
  if (!subject) throw new Error('Email subject is required');

  const normalisedAttachments = normaliseAttachments(attachments);
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
      ...(text ? { text } : {}),
      ...(normalisedAttachments.length ? { attachments: normalisedAttachments } : {})
    })
  });

  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch (error) { body = { raw }; }
  if (!response.ok) throw new Error(body?.message || raw || `Email send failed with status ${response.status}`);
  return body;
}

async function sendApprovedLetter({ employerEmail, clientEmail, clientName, employerName, letter, caseId, document }) {
  const subject = `Formal correspondence regarding ${clientName || 'VRS client'}${employerName ? ` — ${employerName}` : ''}`;
  const intro = `<p>Please find attached formal correspondence issued by Van Rensburg Schoon Inc. in relation to the employment matter referenced ${escapeHtml(caseId)}.</p>`;
  const outro = '<p>Regards,<br>Van Rensburg Schoon Inc.</p>';
  const attachments = document?.buffer && document?.filename ? [{
    filename: document.filename,
    content: document.buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }] : [];

  if (!attachments.length) throw new Error('The approved VRS letter document is missing');

  return sendEmail({
    to: employerEmail,
    cc: clientEmail ? [clientEmail] : [],
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#172033;line-height:1.6">${intro}${outro}</div>`,
    text: `Please find attached formal correspondence issued by Van Rensburg Schoon Inc. in relation to case ${caseId}.\n\nRegards,\nVan Rensburg Schoon Inc.`,
    attachments
  });
}

module.exports = { sendEmail, sendApprovedLetter, letterToHtml };
