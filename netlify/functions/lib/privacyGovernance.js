const crypto = require('crypto');

const DEFAULT_RETENTION_DAYS = Number(process.env.VRS_CONVERSATION_RETENTION_DAYS || 365);

function retentionMetadata({ channel = 'unknown', from = new Date() } = {}) {
  const days = Number.isFinite(DEFAULT_RETENTION_DAYS) && DEFAULT_RETENTION_DAYS > 0 ? DEFAULT_RETENTION_DAYS : 365;
  const start = new Date(from);
  const expires = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    retention_days: days,
    retention_started_at: start.toISOString(),
    retention_expires_at: expires.toISOString(),
    channel,
    pseudonymise_before_analysis: true,
    policy_source: process.env.VRS_CONVERSATION_RETENTION_DAYS ? 'environment' : 'temporary_default'
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
  retentionMetadata,
  pseudonymiseFactsForAnalysis
};
