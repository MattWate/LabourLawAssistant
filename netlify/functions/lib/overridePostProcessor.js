const { enhanceStructuredScore } = require('./structuredScoreEnhancer');

const TRACK_CITATIONS = {
  AUD: ['LRA s187', 'EEA s6', 'LRA s194(3)'],
  CD: ['LRA s186(1)(e)'],
  ULP: ['LRA s186(2)'],
  PDA: ['LRA Schedule 8 Item 4', 'LRA s186(2)(b)'],
  'UD-RETRENCHMENT': ['LRA s189', 'LRA s189A where applicable', 'BCEA s41']
};

const OVERRIDE_CITATIONS = {
  PREGNANCY: ['LRA s187(1)(e)', 'BCEA s25'],
  PROTECTED_DISCLOSURE: ['LRA s187(1)(h)', 'Protected Disclosures Act 26 of 2000'],
  UNLAWFUL_INSTRUCTION_REFUSAL: ['LRA s187(1)(h)', 'Protected Disclosures Act 26 of 2000'],
  SUSPENSION_WITHOUT_PAY: ['LRA s186(2)(b)'],
  UNION_ACTIVITY: ['LRA s187(1)(a)', 'LRA s187(1)(c)'],
  SUSTAINED_NON_PAYMENT: ['BCEA s34', 'BCEA s77'],
  HIV_OR_SICK_LEAVE: ['LRA s187(1)(f)', 'EEA s6'],
  HAZARDOUS_WORK_REFUSAL: ['OHSA s35', 'LRA s187(1)(f)'],
  PROTECTED_GROUND_DISCRIMINATION: ['EEA s6', 'LRA s187(1)(f)'],
  SHAM_RETRENCHMENT: ['LRA s187(1)(e)', 'LRA s187(1)(f)', 'BCEA s41']
};

const OVERRIDE_LABELS = {
  PREGNANCY: 'Pregnancy or pregnancy-related dismissal or treatment',
  PROTECTED_DISCLOSURE: 'Protected disclosure / whistleblowing',
  UNLAWFUL_INSTRUCTION_REFUSAL: 'Refusal to participate in unlawful conduct, falsification, fraud or audit interference',
  SUSPENSION_WITHOUT_PAY: 'Suspension without pay without a prior hearing',
  UNION_ACTIVITY: 'Dismissal related to union membership, activity or strike participation',
  SUSTAINED_NON_PAYMENT: 'Sustained non-payment of salary across more than one pay period',
  HIV_OR_SICK_LEAVE: 'Dismissal of an employee on lawful sick leave or for HIV status',
  HAZARDOUS_WORK_REFUSAL: 'Refusal of hazardous work followed by detriment',
  PROTECTED_GROUND_DISCRIMINATION: 'Protected-ground discrimination overlay',
  SHAM_RETRENCHMENT: 'Sham retrenchment indicators'
};

const FLAG_ALIASES = {
  WHISTLEBLOWER: 'PROTECTED_DISCLOSURE',
  PROTECTED_DISCLOSURE: 'PROTECTED_DISCLOSURE',
  SUSPENSION_WITHOUT_PAY: 'SUSPENSION_WITHOUT_PAY',
  UNION_ACTIVITY: 'UNION_ACTIVITY',
  NON_PAYMENT_OF_SALARY: 'SUSTAINED_NON_PAYMENT',
  SUSTAINED_NON_PAYMENT: 'SUSTAINED_NON_PAYMENT',
  SICK_LEAVE_OR_HIV: 'HIV_OR_SICK_LEAVE',
  HIV_OR_SICK_LEAVE: 'HIV_OR_SICK_LEAVE',
  HAZARDOUS_WORK_REFUSAL: 'HAZARDOUS_WORK_REFUSAL',
  PROTECTED_GROUND_DISCRIMINATION: 'PROTECTED_GROUND_DISCRIMINATION',
  SHAM_RETRENCHMENT: 'SHAM_RETRENCHMENT',
  PREGNANCY: 'PREGNANCY'
};

const clean = value => String(value || '').toLowerCase();
const hasAny = (value, terms) => terms.some(term => clean(value).includes(term));
const dedupe = values => [...new Set((values || []).filter(Boolean))];

function normaliseFlags(flags = []) {
  if (!Array.isArray(flags)) return [];
  return dedupe(flags.map(flag => FLAG_ALIASES[String(flag || '').trim().toUpperCase()]).filter(Boolean));
}

function hasProtectedGroundDiscrimination(text) {
  const t = clean(text);

  const explicitPhrases = [
    'my accent',
    'about my accent',
    'when i am going home',
    'go home',
    'going home',
    'from zimbabwe',
    'zimbabwean',
    'national origin',
    'ethnic origin',
    'xenophobia',
    'xenophobic',
    'racist',
    'racism',
    'because of my race',
    'because of my gender',
    'because of my age',
    'because of my disability',
    'because of my religion',
    'because of my sexual orientation',
    'because of my political opinion',
    'discriminated against me',
    'discrimination against me'
  ];

  if (hasAny(t, explicitPhrases)) return true;

  const protectedGroundField = clean(text.protected_ground || '');
  if (protectedGroundField && hasAny(protectedGroundField, [
    'race', 'gender', 'ethnic origin', 'national origin', 'sexual orientation',
    'disability', 'religion', 'age', 'political opinion'
  ])) return true;

  return false;
}

function detectOverrideFlags(facts = {}, fullStory = '') {
  const text = clean(`${facts.initial_query || ''} ${fullStory} ${facts.protected_ground || ''} ${facts.dismissal_reason_type || ''}`);
  const flags = normaliseFlags(facts.override_flags || []);

  if (hasAny(text, ['pregnant', 'pregnancy', 'maternity', '14 weeks'])) flags.push('PREGNANCY');

  if (hasAny(text, ['whistleblow', 'protected disclosure', 'reported corruption', 'reported unlawful', 'reported fraud'])) {
    flags.push('PROTECTED_DISCLOSURE');
  }

  const refusedInstruction = hasAny(text, ['refused to', 'would not', 'declined to', 'told him i would not', 'i would not do that']);
  const unlawfulContext = hasAny(text, ['remove complaints', 'compliance register', 'auditor', 'audit', 'falsify', 'fraud', 'unlawful', 'illegal', 'customer complaints']);
  if (refusedInstruction && unlawfulContext) flags.push('UNLAWFUL_INSTRUCTION_REFUSAL');

  if (facts.paid_suspension === false || hasAny(text, ['suspended without pay', 'suspension without pay'])) flags.push('SUSPENSION_WITHOUT_PAY');
  if (hasAny(text, ['union activity', 'shop steward', 'trade union', 'union member', 'strike participation'])) flags.push('UNION_ACTIVITY');
  if (hasAny(text, ['two months salary', 'salary arrears', 'unpaid salary', 'non-payment of salary', 'not paid for two'])) flags.push('SUSTAINED_NON_PAYMENT');
  if (hasAny(text, ['hiv', 'lawful sick leave', 'dismissed on sick leave'])) flags.push('HIV_OR_SICK_LEAVE');
  if (hasAny(text, ['hazardous work', 'unsafe work', 'imminent and serious risk', 'refused unsafe'])) flags.push('HAZARDOUS_WORK_REFUSAL');

  if (hasProtectedGroundDiscrimination(`${facts.initial_query || ''} ${fullStory}`) || hasProtectedGroundDiscrimination({ protected_ground: facts.protected_ground })) {
    flags.push('PROTECTED_GROUND_DISCRIMINATION');
  }

  const protectedRetrenchment = flags.includes('PREGNANCY') && hasAny(text, ['retrench', 'restructuring', 'redundant']);
  const shamSignal = hasAny(text, ['position refilled', 'replaced me', 'same role advertised', 'one other junior', 'single employee']);
  if (protectedRetrenchment || shamSignal) flags.push('SHAM_RETRENCHMENT');

  return dedupe(flags);
}

function inferSecondaryTrack(primaryTrack, overrideFlags = [], facts = {}) {
  if (facts.secondary_track) return facts.secondary_track;
  if (!overrideFlags.length) return null;
  const audFlags = ['PREGNANCY', 'PROTECTED_DISCLOSURE', 'UNLAWFUL_INSTRUCTION_REFUSAL', 'UNION_ACTIVITY', 'HIV_OR_SICK_LEAVE', 'HAZARDOUS_WORK_REFUSAL', 'PROTECTED_GROUND_DISCRIMINATION', 'SHAM_RETRENCHMENT'];
  if (overrideFlags.some(flag => audFlags.includes(flag))) return primaryTrack === 'AUD' ? null : 'AUD';
  if (overrideFlags.includes('SUSPENSION_WITHOUT_PAY')) return primaryTrack === 'ULP' ? null : 'ULP';
  return null;
}

function replaceLegalBasisAndFlags(advisory, scorecard) {
  if (!advisory) return advisory;
  const legalText = (scorecard.legal_basis || []).map(item => `- ${item}`).join('\n') || '- To be confirmed by attorney review.';
  const flagText = (scorecard.override_flags || []).map(flag => `- ${OVERRIDE_LABELS[flag] || flag} [${(OVERRIDE_CITATIONS[flag] || []).join('; ')}]`).join('\n');
  const secondaryText = scorecard.secondary_track ? `Secondary track tag: ${scorecard.secondary_track}\n` : '';
  const insert = `${flagText ? `\n\nOverride / secondary-track flags:\n${secondaryText}${flagText}` : ''}\n\nLegal basis:\n${legalText}`;

  const legalIndex = advisory.indexOf('\n\nLegal basis:\n');
  if (legalIndex === -1) return `${advisory}${insert}`;

  const attorneyIndex = advisory.indexOf('\n\nAttorney review tag:', legalIndex);
  if (attorneyIndex === -1) return `${advisory.slice(0, legalIndex)}${insert}`;
  return `${advisory.slice(0, legalIndex)}${insert}${advisory.slice(attorneyIndex)}`;
}

function applyOverridePostProcessing(facts = {}, fullStory = '', scorecard = {}) {
  scorecard = enhanceStructuredScore(facts, scorecard);

  const overrideFlags = detectOverrideFlags(facts, fullStory);
  const secondaryTrack = inferSecondaryTrack(scorecard.track, overrideFlags, facts);

  const legalBasis = [];
  legalBasis.push(...(scorecard.legal_basis || []));
  if (secondaryTrack) legalBasis.push(...(TRACK_CITATIONS[secondaryTrack] || []));
  overrideFlags.forEach(flag => legalBasis.push(...(OVERRIDE_CITATIONS[flag] || [])));

  scorecard.override_flags = overrideFlags;
  scorecard.secondary_track = secondaryTrack;
  scorecard.legal_basis = dedupe(legalBasis);

  if (overrideFlags.length) {
    scorecard.merit_band = 'HIGH';
    scorecard.wp_eligible = true;
    scorecard.wp_type = 'FULL';
    scorecard.recommended_next_step = 'Full WP demand letter, settlement-orientated, attorney priority review.';
    scorecard.merit_bonus_trigger = {
      name: OVERRIDE_LABELS[overrideFlags[0]] || overrideFlags[0],
      legalBasis: (OVERRIDE_CITATIONS[overrideFlags[0]] || []).join('; ')
    };
    scorecard.attorney_review_flag = true;
  }

  scorecard.advisory_note = replaceLegalBasisAndFlags(scorecard.advisory_note, scorecard);
  return scorecard;
}

module.exports = { applyOverridePostProcessing, detectOverrideFlags };