const CONSENT_VERSION = '1.0';
const CONSENT_ISSUED_DATE = '2026-10-12';

const CONSENT_CONFIG = {
  version: CONSENT_VERSION,
  issued_date: CONSENT_ISSUED_DATE,
  is_placeholder: false,
  notice_url: process.env.VRS_TERMS_NOTICE_URL || '/terms.html',
  website: {
    heading: 'Before we start',
    intro: [
      'I’m Justine, the AI assistant of VRS Labour Law Consultants. I’m not a person and I don’t give legal advice. I’ll help you set out what happened at work and give you a first, general view, and a VRS consultant checks every matter before any letter is sent.',
      'AI can get things wrong, so please don’t rely on my answers alone. Talking to me also doesn’t stop legal deadlines: a dismissal dispute must usually be referred to the CCMA within 30 days.'
    ],
    terms_label: 'I am 18 or older and I accept Justine’s Terms of Use and Privacy Notice, including clause 13, which limits VRS’s responsibility.',
    sensitive_label: 'I agree that VRS may use sensitive information I choose to share, such as my health, union membership or an allegation made against me, and that its service providers may process my information outside South Africa.',
    link_label: 'Read the full Terms of Use and Privacy Notice'
  },
  whatsapp: {
    first_message: [
      'Hi, I’m Justine, the AI assistant of VRS Labour Law Consultants. I’m not a person and my answers are general information, not legal advice. A VRS consultant checks every matter before any letter is sent, and using me doesn’t stop legal deadlines.',
      'Please read our Terms of Use and Privacy Notice before we start: {NOTICE_URL}',
      'Reply YES to confirm that:',
      '1. you are 18 or older;',
      '2. you accept them, including the limits on VRS’s responsibility in clause 13; and',
      '3. VRS may use any sensitive information you share, and its service providers may process your information outside South Africa.'
    ].join('\n')
  },
  mandate: {
    version: '2026-11-03',
    text: [
      'Unfortunately, many of our clients do not always understand the basis upon which we accept instructions. In order to avoid any confusion or misunderstanding, we record that basis below:',
      '',
      'You, (“the client”) are always liable for payment of all fees and disbursements unless we have specifically agreed to the contrary in writing.',
      '',
      'All accounts are payable immediately against the rendering thereof, unless agreed otherwise with the consultant.',
      '',
      'If the firm considers that the complexity and/or substantial nature of the client’s case warrants it, the client acknowledges that it may be necessary for more than one Consultant or Agent to be involved in handling the client’s case at any one time, to which the client agrees. The client further agrees that non-litigious and/or commercial work will be billed taking into consideration the complexity, time spent, skills and experience of the Consultant or Agent involved, the nature of the agreement and the extent of any benefits derived for the client.',
      '',
      'By accepting this mandate, you authorise the Consultant or Agent to receive monies which may be due to you stemming from a labour case matter, and recover from such monies received on your behalf.'
    ].join('\n')
  },
  pre_payment: {
    text: 'Please start work on my matter as soon as I pay. I understand that once work has started the seven-day cooling-off right for online purchases no longer applies, and that VRS will refund my fee in full if it declines to act or does not release a letter.'
  }
};

function consentSnapshot(channel = 'unknown', extra = {}) {
  return {
    accepted: true,
    terms_accepted: true,
    sensitive_information_consent: true,
    cross_border_processing_consent: true,
    age_18_or_over_confirmed: true,
    version: CONSENT_CONFIG.version,
    issued_date: CONSENT_CONFIG.issued_date,
    accepted_at: new Date().toISOString(),
    channel,
    ...extra
  };
}

function mandateAcceptanceSnapshot(channel = 'unknown') {
  return {
    accepted: true,
    version: CONSENT_CONFIG.mandate.version,
    accepted_at: new Date().toISOString(),
    channel,
    wording: CONSENT_CONFIG.mandate.text
  };
}

function paymentConsentSnapshot(channel = 'unknown') {
  return {
    accepted: true,
    version: CONSENT_CONFIG.version,
    accepted_at: new Date().toISOString(),
    channel,
    wording: CONSENT_CONFIG.pre_payment.text
  };
}

function whatsappConsentText() {
  return CONSENT_CONFIG.whatsapp.first_message.replace('{NOTICE_URL}', CONSENT_CONFIG.notice_url);
}

module.exports = {
  CONSENT_CONFIG,
  CONSENT_VERSION,
  CONSENT_ISSUED_DATE,
  consentSnapshot,
  mandateAcceptanceSnapshot,
  paymentConsentSnapshot,
  whatsappConsentText
};
