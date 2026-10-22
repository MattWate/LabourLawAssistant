const crypto = require('crypto');

const UNPAID_RETENTION_MONTHS = 12;
const PAID_FILE_RETENTION_YEARS = 5;

function addMonths(date, months) {
  const value = new Date(date);
  const originalDay = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(originalDay, lastDay));
  return value;
}

function addYears(date, years) {
  const value = new Date(date);
  value.setUTCFullYear(value.getUTCFullYear() + years);
  return value;
}

function retentionMetadata({ channel = 'unknown', from = new Date(), paid = false, matterClosedAt = null } = {}) {
  const start = new Date(from);
  const unpaidDeadline = addMonths(start, UNPAID_RETENTION_MONTHS);
  const closed = matterClosedAt ? new Date(matterClosedAt) : null;
  const paidDeadline = paid && closed ? addYears(closed, PAID_FILE_RETENTION_YEARS) : null;

  return {
    notice_version: '1.0',
    channel,
    policy: {
      unpaid_service: 'Delete the conversation or remove identifying information within 12 months if no paid service is taken.',
      paid_service: 'Keep the file for five years after the matter closes unless the law requires longer.',
      anonymised_improvement_use: true
    },
    retention_started_at: start.toISOString(),
    unpaid_identifiable_until: unpaidDeadline.toISOString(),
    paid_service: paid === true,
    matter_closed_at: closed ? closed.toISOString() : null,
    paid_file_retention_until: paidDeadline ? paidDeadline.toISOString() : null,
    pseudonymise_before_analysis: true,
    policy_source: 'VRS Justine Terms of Use, Privacy Notice and AI Disclosure v1.0 clause 10'
  };
}

function stableToken(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return null;
  const salt = String(process.env.VRS_PSEUDONYMISATION_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || 'vrs-local-salt');
  return crypto.createHmac('sha256', salt).update(clean).digest('hex').slice(0, 16);
}

function pseudonymiseFactsForAnalysis(facts = {}) {
  const source = JSON.parse(JSON.stringify(facts || {}));
  const token = stableToken(source.client_email || source.contact_info || source.client_name || '');
  const protectedKeys = [
    'client_name','contact_info','client_email','contact_email','whatsapp_number',
    'employer_contact_details','employer_email','employer_contact_email',
    'addressee_name'
  ];

  protectedKeys.forEach(key => {
    if (key in source) delete source[key];
  });

  if (source._fact_metadata) {
    protectedKeys.forEach(key => {
      if (source._fact_metadata[key]) delete source._fact_metadata[key];
    });
  }

  source.analysis_subject_token = token;
  source.analysis_pseudonymised = true;
  source.analysis_pseudonymised_at = new Date().toISOString();
  return source;
}

module.exports = {
  UNPAID_RETENTION_MONTHS,
  PAID_FILE_RETENTION_YEARS,
  retentionMetadata,
  pseudonymiseFactsForAnalysis
};
