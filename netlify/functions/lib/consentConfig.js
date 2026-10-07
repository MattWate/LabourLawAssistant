const CONSENT_VERSION = 'placeholder-2026-10-07';

const CONSENT_CONFIG = {
  version: CONSENT_VERSION,
  is_placeholder: true,
  heading: 'Before we begin',
  text: [
    'PLACEHOLDER – VRS APPROVED WORDING TO BE INSERTED.',
    'By continuing, you confirm that you have read and accept the VRS terms, privacy notice and disclaimer.',
    'You consent to VRS processing information you provide about health, trade-union membership and alleged offences where relevant to your matter.',
    'You also consent to information being processed outside South Africa where this is required to provide the service.',
    'Justine uses artificial intelligence to help process information and generate content. A VRS practitioner reviews legal outcomes and any letter before release.'
  ].join('\n\n'),
  accept_label: 'I accept and consent',
  decline_label: 'I do not accept'
};

function consentSnapshot(channel = 'unknown') {
  return {
    accepted: true,
    version: CONSENT_CONFIG.version,
    accepted_at: new Date().toISOString(),
    channel,
    placeholder_wording: CONSENT_CONFIG.is_placeholder === true
  };
}

module.exports = { CONSENT_CONFIG, CONSENT_VERSION, consentSnapshot };
