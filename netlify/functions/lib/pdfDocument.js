const PDFDocument = require('pdfkit');
const { parsePlainDraftToBlocks } = require('./letterStructure');

function safe(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function safeFilename(value = '') {
  return safe(value, 'Client')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Client';
}

function formatDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function renderReleasedLetterPdf({ caseId, facts = {}, draft = '', approvedAt }) {
  if (!caseId) throw new Error('Case ID is required for PDF generation');
  if (!safe(draft)) throw new Error('Approved letter text is empty');

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 55, left: 58, right: 58 },
        info: {
          Title: `VRS Without Prejudice Letter - ${safe(facts.client_name, 'Client')}`,
          Author: 'Van Rensburg Schoon Inc.'
        }
      });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        filename: `VRS_WP_${safeFilename(facts.client_name)}_${String(caseId).slice(0, 8).toUpperCase()}.pdf`,
        content_type: 'application/pdf'
      }));
      doc.on('error', reject);

      const clientName = safe(facts.client_name, 'Client');
      const employerName = safe(facts.employer_name, 'Employer');
      const recipientName = safe(facts.recipient_name || facts.employer_contact_name || facts.addressee_name, '');
      const recipientPosition = safe(facts.addressee_position || facts.recipient_position, '');
      const employerEmail = safe(facts.employer_email || facts.employer_contact_email || facts.employer_contact_details, '');
      const reference = safe(facts.case_reference || facts.our_reference || facts.vrs_reference, String(caseId));
      const subject = safe(
        facts.letter_subject || facts.subject_heading,
        facts.dismissal_reason_type ? `${facts.dismissal_reason_type.toUpperCase()} EMPLOYMENT MATTER` : 'EMPLOYMENT MATTER'
      );

      doc.font('Helvetica-Bold').fontSize(15).text('VAN RENSBURG SCHOON INC.');
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(9).text(safe(process.env.VRS_SENDER_EMAIL || facts.sender_email, 'info@vrslabourlaw.co.za'));
      doc.moveDown(1.3);

      doc.font('Helvetica-Bold').fontSize(10).text('WITHOUT PREJUDICE AND SUBJECT TO CONTRACT', { align: 'center' });
      doc.moveDown(1.2);

      doc.font('Helvetica').fontSize(10).text(formatDate(approvedAt || new Date()));
      doc.moveDown(0.8);
      if (recipientName) doc.text(recipientName);
      if (recipientPosition) doc.text(recipientPosition);
      doc.text(employerName);
      if (employerEmail) doc.text(`BY EMAIL: ${employerEmail}`);
      doc.moveDown(1);

      doc.font('Helvetica-Bold').text(`OUR REFERENCE: ${reference}`);
      doc.text(`RE: ${subject.toUpperCase()}`);
      doc.moveDown(1);

      doc.font('Helvetica').text(safe(facts.letter_salutation, 'Dear Sir / Madam,'));
      doc.moveDown(0.8);

      const blocks = parsePlainDraftToBlocks(draft);
      blocks.forEach(block => {
        if (block.type === 'bullet') {
          doc.text(`•  ${block.text}`, { indent: 14, lineGap: 2, align: 'justify' });
        } else if (block.type === 'numbered') {
          doc.text(`${block.number}. ${block.text}`, { indent: 8, lineGap: 2, align: 'justify' });
        } else {
          doc.text(block.text, { lineGap: 2, align: 'justify' });
        }
        doc.moveDown(0.65);
      });

      doc.moveDown(0.3);
      doc.text(safe(facts.closing_sentence, 'It is trusted that you will find same to be in order.'));
      doc.moveDown(1);
      doc.text('Yours faithfully,');
      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').text(safe(process.env.VRS_FIRM_NAME, 'VAN RENSBURG SCHOON INC.'));
      doc.font('Helvetica').text(safe(process.env.VRS_DEFAULT_SIGNATORY || facts.signatory_name, 'Sasha-Lee van Wyk'));
      doc.fontSize(8).text(safe(process.env.VRS_ELECTRONIC_SIGNATURE_NOTE, 'Not signed due to electronic submission'));

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { renderReleasedLetterPdf };
