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

async function sendEmail({ to, cc = [], bcc = [], subject, html, text, attachments = [] }) {
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
      ...(Array.isArray(bcc) && bcc.length ? { bcc } : {}),
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

async function sendClientReviewInvitation({ clientEmail, clientName, employerName, caseReference, reviewUrl, expiresAt }) {
  if (!clientEmail) throw new Error('A client email address is required for letter review');
  if (!reviewUrl) throw new Error('Client review URL is required');

  const subject = `Your VRS letter is ready for approval — ${caseReference || 'employment matter'}`;
  const expiryText = expiresAt ? new Date(expiresAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) : '12 hours';
  const safeUrl = escapeHtml(reviewUrl);
  const greeting = clientName ? `Hi ${escapeHtml(clientName)},` : 'Hello,';
  const employer = employerName ? ` for your matter with ${escapeHtml(employerName)}` : '';

  return sendEmail({
    to: clientEmail,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#172033;line-height:1.6">
      <p>${greeting}</p>
      <p>VRS has prepared the letter${employer}. Before it can be sent to the employer, you must review and approve the wording.</p>
      <p><a href="${safeUrl}" style="display:inline-block;background:#20368F;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Review your letter</a></p>
      <p>If you need changes, use the change-request box on the review page. VRS will review any revised draft before you are asked to approve it again.</p>
      <p>This private review link expires at ${escapeHtml(expiryText)}.</p>
      <p>Regards,<br>Van Rensburg Schoon Inc.</p>
    </div>`,
    text: `${clientName ? `Hi ${clientName},` : 'Hello,'}\n\nVRS has prepared your letter${employerName ? ` for your matter with ${employerName}` : ''}. You must review and approve it before it can be sent to the employer.\n\nReview it here: ${reviewUrl}\n\nIf you need changes, submit them on the review page. This private link expires at ${expiryText}.\n\nRegards,\nVan Rensburg Schoon Inc.`
  });
}

async function sendApprovedLetter({ employerEmail, clientEmail, clientName, employerName, letter, caseId, document }) {
  const subject = `WITHOUT PREJUDICE AND SUBJECT TO CONTRACT — ${clientName || 'VRS client'}${employerName ? ` / ${employerName}` : ''}`;
  const intro = `<p>Please find attached formal correspondence issued by Van Rensburg Schoon Inc. in relation to the employment matter referenced ${escapeHtml(caseId)}.</p>`;
  const outro = '<p>Regards,<br>Van Rensburg Schoon Inc.</p>';
  const attachments = document?.buffer && document?.filename ? [{
    filename: document.filename,
    content: document.buffer,
    contentType: document.contentType || 'application/pdf'
  }] : [];

  if (!attachments.length) throw new Error('The approved VRS letter document is missing');

  return sendEmail({
    to: employerEmail,
    bcc: clientEmail ? [clientEmail] : [],
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#172033;line-height:1.6">${intro}${outro}</div>`,
    text: `Please find attached formal correspondence issued by Van Rensburg Schoon Inc. in relation to case ${caseId}.\n\nRegards,\nVan Rensburg Schoon Inc.`,
    attachments
  });
}

module.exports = { sendEmail, sendApprovedLetter, sendClientReviewInvitation, letterToHtml };
