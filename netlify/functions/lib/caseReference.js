const crypto = require('crypto');

function caseReference(caseId, createdAt = null) {
  const id = String(caseId || '').trim();
  if (!id) return null;

  const date = createdAt ? new Date(createdAt) : new Date();
  const year = Number.isNaN(date.getTime()) ? new Date().getFullYear() : date.getFullYear();
  const yy = String(year).slice(-2);
  const token = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12).toUpperCase();
  return `VRS-${yy}-${token}`;
}

function withCaseReference(caseRow = {}) {
  if (!caseRow?.id) return caseRow;
  const reference = caseRow.case_facts?.case_reference || caseReference(caseRow.id, caseRow.created_at);
  return {
    ...caseRow,
    case_reference: reference,
    case_facts: {
      ...(caseRow.case_facts || {}),
      case_reference: reference
    }
  };
}

module.exports = { caseReference, withCaseReference };
