const { determineRecommendation } = require('./strategicMatrix');

const TRACK_LABELS = {
  'UD-MISCONDUCT': 'Unfair Dismissal — Misconduct',
  'UD-POOR_PERFORMANCE': 'Unfair Dismissal — Poor Performance',
  'UD-INCAPACITY': 'Unfair Dismissal — Incapacity',
  'UD-RETRENCHMENT': 'Unfair Dismissal — Retrenchment',
  CD: 'Constructive Dismissal',
  AUD: 'Automatically Unfair Dismissal / Unfair Labour Practice',
  ULP: 'Unfair Labour Practice',
  PDA: 'Pre-Dismissal Advisory',
  ANC: 'Ancillary Advisory'
};

const LEGAL_BASIS = {
  'UD-MISCONDUCT': ['LRA s188', 'Schedule 8 Item 7', 'Schedule 8 Item 4'],
  'UD-POOR_PERFORMANCE': ['LRA s188', 'Schedule 8 Item 9'],
  'UD-INCAPACITY': ['LRA s188', 'Schedule 8 Items 10 and 11', 'EEA s15 where disability is implicated'],
  'UD-RETRENCHMENT': ['LRA s189', 'LRA s189A where applicable', 'BCEA s41'],
  CD: ['LRA s186(1)(e)'],
  AUD: ['LRA s187', 'LRA s186(2)', 'EEA s6', 'Protected Disclosures Act 26 of 2000'],
  ULP: ['LRA s186(2)', 'LRA s186(2)(b)', 'LRA s186(2)(c)'],
  PDA: ['LRA Schedule 8 Item 4', 'LRA s186(2)(b)'],
  ANC: ['LRA s186(2)', 'Schedule 8 Items 3 and 4']
};

const clean = value => String(value ?? '').trim().toLowerCase();
const hasAny = (value, terms) => terms.some(term => clean(value).includes(term));
const clamp = value => Math.max(0, Math.min(10, Math.round((Number(value) || 0) * 10) / 10));
const isNo = value => value === false || clean(value).includes('false') || clean(value) === 'no';
const isYes = value => value === true || clean(value).includes('true') || clean(value) === 'yes';
const dedupe = values => [...new Set((values || []).filter(Boolean))];

function add(breakdown, channel, points, label, legalHook) {
  if (!points) return;
  breakdown.push({ channel, points, label, legalHook });
}

function inferTrack(facts = {}) {
  if (facts.track && TRACK_LABELS[facts.track]) return facts.track;
  const status = clean(facts.employment_status || facts.category);
  const reason = clean(facts.dismissal_reason_type || facts.reason_type || facts.stated_reason);
  const topic = clean(facts.advisory_topic || facts.ancillary_topic);
  const story = clean(`${facts.initial_query || ''} ${facts.incident_description || ''}`);
  if (status.includes('discrimination') || status.includes('aud')) return 'AUD';
  if (status.includes('ulp') || topic.includes('suspension') || facts.paid_suspension === false) return 'ULP';
  if (status.includes('resigned') || status.includes('constructive')) return 'CD';
  if (status.includes('advisory') || status.includes('employed')) {
    if (topic.includes('hearing') || story.includes('disciplinary hearing')) return 'PDA';
    return 'ANC';
  }
  if (status.includes('dismissed') || status.includes('fired') || status.includes('retrench')) {
    if (reason.includes('poor')) return 'UD-POOR_PERFORMANCE';
    if (reason.includes('incapacity') || reason.includes('ill') || reason.includes('injury') || reason.includes('health')) return 'UD-INCAPACITY';
    if (reason.includes('retrench') || reason.includes('operational')) return 'UD-RETRENCHMENT';
    return 'UD-MISCONDUCT';
  }
  if (hasAny(story, ['pregnan', 'union', 'whistle', 'discriminat'])) return 'AUD';
  if (hasAny(story, ['suspended without pay', 'suspension without pay'])) return 'ULP';
  if (hasAny(story, ['resign', 'intolerable', 'forced to quit'])) return 'CD';
  if (hasAny(story, ['hearing', 'charge sheet']) && !story.includes('dismissed')) return 'PDA';
  return 'ANC';
}

function ccmaStatus(facts = {}) {
  const dateValue = facts.incident_date || facts.dismissal_date || facts.resignation_date || facts.relevant_event_date;
  if (!dateValue) return { status: 'UNKNOWN', daysElapsed: null, daysRemaining: null };
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return { status: 'UNKNOWN', daysElapsed: null, daysRemaining: null };
  const daysElapsed = Math.floor((Date.now() - date.getTime()) / 86400000);
  return daysElapsed <= 30
    ? { status: 'WITHIN_WINDOW', daysElapsed, daysRemaining: 30 - daysElapsed }
    : { status: 'LAPSED-CONDONATION', daysElapsed, daysRemaining: 30 - daysElapsed };
}

function hardDisqualifier(facts = {}, track) {
  const contract = clean(facts.contract_type || facts.worker_status);
  const control = clean(facts.contractor_control_test || facts.control_test);
  const sector = clean(facts.sector || facts.employer_sector || facts.public_service_status);
  const deadline = ccmaStatus(facts);
  if (contract.includes('contractor') && !control.includes('yes')) return { name: 'Independent contractor not reversed by control test', legalBasis: 'LRA s200A' };
  if (deadline.status === 'LAPSED-CONDONATION' && facts.condonation_elected === false) return { name: 'Referral window lapsed and condonation declined', legalBasis: 'CCMA Rule 9' };
  if (sector.includes('sandf') || sector.includes('military')) return { name: 'Excluded SANDF / military matter', legalBasis: 'LRA s2(2)' };
  if (track !== 'CD' && clean(facts.employment_status).includes('resigned') && !hasAny(`${facts.initial_query || ''} ${facts.incident_description || ''}`, ['intolerable', 'forced', 'constructive', 'harass', 'bully', 'unpaid'])) return { name: 'Voluntary resignation with no reported intolerable conditions', legalBasis: 'LRA s186(1)(e)' };
  return null;
}

function meritBonus(facts = {}) {
  const story = `${facts.initial_query || ''} ${facts.incident_description || ''} ${facts.protected_ground || ''}`;
  if (hasAny(story, ['pregnant', 'pregnancy', 'maternity'])) return { name: 'Dismissal during or because of pregnancy', legalBasis: 'LRA s187(1)(e)' };
  if (hasAny(story, ['whistleblow', 'protected disclosure', 'reported corruption'])) return { name: 'Protected disclosure / whistleblowing', legalBasis: 'Protected Disclosures Act 26 of 2000' };
  if (hasAny(story, ['union activity', 'shop steward', 'trade union', 'union member'])) return { name: 'Union membership or activity', legalBasis: 'LRA s187(1)(a)' };
  if (hasAny(story, ['hiv', 'lawful sick leave', 'sick leave'])) return { name: 'Dismissal linked to lawful sick leave or HIV status', legalBasis: 'LRA s187(1)(f); EEA s6' };
  if (hasAny(story, ['not paid', 'non-payment', 'salary arrears', 'unpaid salary', 'two months salary'])) return { name: 'Sustained non-payment of salary', legalBasis: 'BCEA s34, s77' };
  if (facts.paid_suspension === false || clean(facts.paid_suspension).includes('without pay')) return { name: 'Suspension without pay without prior hearing', legalBasis: 'LRA s186(2)(b)' };
  return null;
}

function tenurePoint(facts, breakdown) {
  const tenure = clean(facts.tenure || facts.length_of_service || facts.employment_length || facts.incident_description);
  if (hasAny(tenure, ['5 year', 'five year', '6 year', 'six year', '7 year', '8 year', '9 year', '10 year', '5+y'])) {
    add(breakdown, 'substantive', 1, 'Long service strengthens proportionality', 'Schedule 8 proportionality');
    return 1;
  }
  if (hasAny(tenure, ['2-5', '2 year', '3 year', '4 year'])) {
    add(breakdown, 'substantive', 0.5, 'Material service history may assist proportionality', 'Schedule 8 proportionality');
    return 0.5;
  }
  return 0;
}

function scoreMisconduct(facts, breakdown, story) {
  let substantive = 3, procedural = 3, substantiveCap = null;
  const admission = clean(facts.conduct_admission || facts.admission || facts.admit_dispute);
  const category = clean(facts.misconduct_category || facts.dismissal_reason_type || facts.reason_type);
  const gross = hasAny(`${category} ${story}`, ['theft', 'fraud', 'assault', 'dishonest', 'dishonesty', 'gross misconduct']);
  if (admission.includes('partial')) { substantive += 1; substantiveCap = 5; add(breakdown, 'substantive', 1, 'Partial admission leaves limited proportionality room', 'Schedule 8 Item 7'); add(breakdown, 'substantive', -1, 'Partial admission caps substantive merit at 5/10', 'Schedule 8 Item 7'); }
  else if (admission.includes('admit') && gross) { substantiveCap = 3; add(breakdown, 'substantive', -2, 'Gross misconduct appears admitted', 'Schedule 8 Item 7'); }
  else if (admission.includes('admit')) { substantiveCap = 5; add(breakdown, 'substantive', -1, 'Misconduct appears admitted, so substantive merit is capped at 5/10', 'Schedule 8 Item 7'); }
  else if (admission.includes('dispute')) { substantive += 2; add(breakdown, 'substantive', 2, 'The alleged misconduct is disputed', 'LRA s188'); }
  const warnings = clean(facts.prior_warnings || facts.warnings);
  if (warnings.includes('none') && !gross) { substantive += 2; add(breakdown, 'substantive', 2, 'No prior warning for a non-gross offence', 'Schedule 8 Item 7'); }
  if (warnings.includes('multiple')) { substantive -= 1; add(breakdown, 'substantive', -1, 'Multiple prior warnings weaken proportionality', 'Schedule 8 Item 7'); }
  substantive += tenurePoint(facts, breakdown);
  if (substantiveCap !== null) substantive = Math.min(substantive, substantiveCap);
  if (isNo(facts.hearing_held)) { procedural += 4; add(breakdown, 'procedural', 4, 'No formal disciplinary hearing before dismissal', 'Schedule 8 Item 4'); }
  if (isNo(facts.proc_notice) || clean(facts.proc_notice).includes('same')) { procedural += 2; add(breakdown, 'procedural', 2, 'Insufficient notice of hearing or charges', 'Schedule 8 Item 4'); }
  if (isNo(facts.proc_rep)) { procedural += 2; add(breakdown, 'procedural', 2, 'Representation was refused or not allowed', 'Schedule 8 Item 4'); }
  if (isNo(facts.proc_chair) || hasAny(story, ['chair was my manager', 'biased chair'])) { procedural += 3; add(breakdown, 'procedural', 3, 'Chairperson independence appears defective', 'Schedule 8 Item 4'); }
  return { substantive, procedural };
}

function scorePoorPerformance(facts, breakdown, story) {
  let substantive = 3, procedural = 3;
  const standards = clean(facts.performance_standards_communicated);
  const pipDuration = clean(facts.pip_duration || facts.performance_improvement_period);
  const training = clean(facts.training_provided);
  const comparator = clean(facts.team_meeting_standards || facts.performance_comparator);
  const control = clean(facts.performance_control || facts.performance_external_factors);
  const warnings = clean(facts.prior_performance_warnings || facts.performance_warnings);
  if (isNo(facts.performance_standards_communicated) || hasAny(story, ['unclear target', 'unclear standard', 'never told'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Performance standards may not have been clearly communicated', 'Schedule 8 Item 9'); }
  else if (standards.includes('unclear')) { substantive += 1; add(breakdown, 'substantive', 1, 'Performance standards were unclear', 'Schedule 8 Item 9'); }
  if (isNo(facts.pip_given) || hasAny(story, ['no pip', 'no performance improvement plan'])) { procedural += 4; add(breakdown, 'procedural', 4, 'No formal opportunity to improve', 'Schedule 8 Item 9'); }
  if (pipDuration.includes('<2') || pipDuration.includes('less than 2')) { procedural += 2; add(breakdown, 'procedural', 2, 'The improvement period appears rushed', 'Schedule 8 Item 9'); }
  else if (pipDuration.includes('2-4')) { procedural += 1; add(breakdown, 'procedural', 1, 'The improvement period may have been short', 'Schedule 8 Item 9'); }
  else if (pipDuration.includes('3+')) { procedural -= 1; add(breakdown, 'procedural', -1, 'The employer appears to have allowed a longer improvement period', 'Schedule 8 Item 9'); }
  if (isNo(facts.training_provided) || hasAny(story, ['no training', 'no support', 'no guidance'])) { procedural += 2; add(breakdown, 'procedural', 2, 'No training, instruction or guidance provided', 'Schedule 8 Item 9'); }
  else if (training.includes('inadequate')) { procedural += 1; add(breakdown, 'procedural', 1, 'Training, instruction or guidance may have been inadequate', 'Schedule 8 Item 9'); }
  if (comparator === 'no' || hasAny(story, ['nobody hit target', 'nobody on my team', 'team missed target', 'comparator'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Comparator evidence suggests the standard may not have been reasonable', 'Schedule 8 Item 9'); }
  if (control.includes('external')) { substantive += 2; add(breakdown, 'substantive', 2, 'External factors may have affected performance', 'Schedule 8 Item 9'); }
  else if (control.includes('both')) { substantive += 1; add(breakdown, 'substantive', 1, 'Performance may have been partly affected by external factors', 'Schedule 8 Item 9'); }
  if (warnings.includes('none')) { procedural += 2; add(breakdown, 'procedural', 2, 'No prior performance warnings were given before dismissal', 'Schedule 8 Item 9'); }
  substantive += tenurePoint(facts, breakdown);
  return { substantive, procedural };
}

function scoreIncapacity(facts, breakdown, story) {
  let substantive = 3, procedural = 3;
  if (hasAny(`${facts.incapacity_duration || ''} ${story}`, ['temporary', 'recover', 'medical certificate', 'sick note'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Temporary incapacity or medical evidence supports accommodation', 'Schedule 8 Items 10 and 11'); }
  if (isNo(facts.proc_consultation) || hasAny(`${facts.proc_consultation || ''} ${story}`, ['brief meeting', 'no consultation', 'only one meeting'])) { procedural += 4; add(breakdown, 'procedural', 4, 'Inadequate consultation about the incapacity', 'Schedule 8 Items 10 and 11'); }
  if (isNo(facts.medical_review) || isNo(facts.proc_medical_review) || hasAny(story, ['no medical review', 'ignored medical'])) { procedural += 3; add(breakdown, 'procedural', 3, 'Employer may not have reviewed medical evidence properly', 'Schedule 8 Items 10 and 11'); }
  if (isNo(facts.alternatives_explored) || isNo(facts.proc_alternatives_explored) || hasAny(story, ['no alternative', 'no accommodation', 'refused accommodation', 'adapted duties'])) { procedural += 3; substantive += 2; add(breakdown, 'procedural', 3, 'Alternatives to dismissal may not have been explored', 'Schedule 8 Items 10 and 11'); add(breakdown, 'substantive', 2, 'Failure to consider accommodation strengthens the employee position', 'EEA s15'); }
  substantive += tenurePoint(facts, breakdown);
  return { substantive, procedural };
}

function scoreConstructiveDismissal(facts, breakdown, story) {
  let substantive = 3, procedural = 3;
  const conduct = clean(facts.intolerable_conduct);
  const duration = clean(facts.intolerable_duration);
  const grievance = clean(facts.grievance_raised || facts.constructive_grievance_raised);
  const noReason = clean(facts.no_grievance_reason);
  const response = clean(facts.employer_response);
  const wait = clean(facts.wait_after_grievance);
  const colleagues = clean(facts.colleagues_witnessed);
  if (hasAny(conduct, ['salary', 'non-payment'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Non-payment of salary supports intolerability', 'LRA s186(1)(e)'); }
  if (hasAny(conduct, ['harassment', 'bullying', 'discrimination', 'unsafe'])) { substantive += 2; add(breakdown, 'substantive', 2, 'Serious workplace conduct may support intolerability', 'LRA s186(1)(e)'); }
  if (hasAny(conduct, ['demotion', 'unilateral'])) { substantive += 2; add(breakdown, 'substantive', 2, 'Demotion or unilateral contract change may support intolerability', 'LRA s186(1)(e)'); }
  if (duration.includes('3-6')) { substantive += 1; add(breakdown, 'substantive', 1, 'Duration of conditions supports intolerability', 'LRA s186(1)(e)'); }
  if (duration.includes('6+')) { substantive += 2; add(breakdown, 'substantive', 2, 'Sustained duration of conditions supports intolerability', 'LRA s186(1)(e)'); }
  if (grievance.includes('writing')) { procedural += 3; add(breakdown, 'procedural', 3, 'Employee raised a written grievance before resigning', 'LRA s186(1)(e)'); }
  else if (grievance.includes('verbally')) { procedural += 1; add(breakdown, 'procedural', 1, 'Employee raised the issue verbally before resigning', 'LRA s186(1)(e)'); }
  else if (grievance === 'no') { procedural -= 2; add(breakdown, 'procedural', -2, 'No grievance attempt is recorded yet', 'LRA s186(1)(e)'); }
  if (hasAny(noReason, ['futile', 'perpetrator'])) { procedural += 3; add(breakdown, 'procedural', 3, 'Absence of grievance may be excused by futility or employer involvement', 'LRA s186(1)(e)'); }
  else if (noReason.includes('retaliation')) { procedural += 1; add(breakdown, 'procedural', 1, 'Fear of retaliation may partly explain no grievance', 'LRA s186(1)(e)'); }
  if (response.includes('no action')) { substantive += 2; add(breakdown, 'substantive', 2, 'Employer took no action to address concerns', 'LRA s186(1)(e)'); }
  else if (response.includes('partial')) { substantive += 1; add(breakdown, 'substantive', 1, 'Employer response was only partial', 'LRA s186(1)(e)'); }
  else if (response.includes('full')) { substantive -= 2; add(breakdown, 'substantive', -2, 'Full resolution weakens the constructive dismissal claim', 'LRA s186(1)(e)'); }
  if (wait.includes('<2') && !hasAny(noReason, ['futile', 'perpetrator'])) { procedural -= 1; add(breakdown, 'procedural', -1, 'Resignation may have followed too quickly after grievance', 'LRA s186(1)(e)'); }
  if (wait.includes('1-3')) { procedural += 1; add(breakdown, 'procedural', 1, 'Employee gave employer time to remedy', 'LRA s186(1)(e)'); }
  if (wait.includes('3+')) { procedural += 2; add(breakdown, 'procedural', 2, 'Employee allowed significant time for remedy before resigning', 'LRA s186(1)(e)'); }
  if (colleagues === 'yes') { substantive += 1; add(breakdown, 'substantive', 1, 'Colleague corroboration may support the intolerability claim', 'LRA s186(1)(e)'); }
  if (hasAny(story, ['assault', 'threat', 'slur'])) { substantive += 1; add(breakdown, 'substantive', 1, 'Narrative includes severity markers', 'LRA s186(1)(e)'); }
  return { substantive, procedural };
}

function scoreAudUlp(facts, breakdown, story) {
  let substantive = 3, procedural = 3;
  const status = clean(facts.disc_status || facts.protected_ground_status);
  const ground = clean(facts.protected_ground);
  const comparator = clean(facts.protected_ground_comparator);
  const reported = clean(facts.protected_ground_reported);
  const worsened = clean(facts.employer_response_worsened);
  const tenure = tenurePoint(facts, breakdown);
  if (status.includes('resigned')) return scoreConstructiveDismissal(facts, breakdown, story);
  if (facts.paid_suspension === false || hasAny(story, ['suspended without pay', 'suspension without pay'])) { substantive += 5; procedural += 3; add(breakdown, 'substantive', 5, 'Suspension without pay creates strong unfair labour practice leverage', 'LRA s186(2)(b)'); add(breakdown, 'procedural', 3, 'No hearing before unpaid suspension creates a procedural defect', 'LRA s186(2)(b)'); }
  if (hasAny(ground, ['pregnancy', 'hiv', 'union activity', 'whistleblowing'])) { substantive += 5; add(breakdown, 'substantive', 5, 'Confirmed protected ground triggers high-merit AUD/ULP treatment', 'LRA s187 / EEA s6 / PDA'); }
  else if (hasAny(ground, ['race', 'gender', 'sexual orientation', 'disability', 'religion', 'age', 'political opinion', 'other'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Protected ground indicated', 'LRA s187 / EEA s6'); }
  if (comparator === 'yes') { substantive += 2; add(breakdown, 'substantive', 2, 'Comparator evidence may support the claim', 'EEA s6'); }
  if (reported.includes('writing')) { procedural += 2; add(breakdown, 'procedural', 2, 'Discrimination or unfair treatment was reported in writing', 'LRA s186(2)'); }
  else if (reported.includes('verbally')) { procedural += 1; add(breakdown, 'procedural', 1, 'Discrimination or unfair treatment was reported verbally', 'LRA s186(2)'); }
  if (worsened === 'yes') { substantive += 2; add(breakdown, 'substantive', 2, 'Employer response worsened the situation after reporting', 'Protected Disclosures Act / occupational detriment'); }
  else if (worsened.includes('no response')) { substantive += 1; add(breakdown, 'substantive', 1, 'Employer gave no response after report', 'LRA s186(2)'); }
  substantive += tenure;
  return { substantive, procedural };
}

function scoreAncillary(facts, breakdown, story) {
  let substantive = 2, procedural = 2;
  const topic = clean(facts.advisory_topic || facts.ancillary_topic);

  const warningMatter = topic.includes('warning') || topic.includes('e1') || hasAny(story, ['final written warning', 'written warning', 'warning challenge', 'warning unfair']);
  const suspensionMatter = facts.paid_suspension === false || topic.includes('suspension') || hasAny(story, ['suspended without pay', 'suspension without pay']);
  const payMatter = topic.includes('pay') || topic.includes('bcea') || hasAny(story, ['unpaid', 'deduction', 'salary arrears', 'non-payment', 'not paid']);
  const grievanceMatter = topic.includes('grievance') || hasAny(story, ['grievance', 'raised internally', 'emailed hr']);

  if (suspensionMatter) {
    substantive = 7;
    procedural = 6;
    add(breakdown, 'substantive', 5, 'Suspension without pay is treated as strong unfair labour practice leverage', 'LRA s186(2)(b)');
    if (isNo(facts.hearing_held) || hasAny(story, ['no hearing', 'without a hearing', 'no disciplinary hearing'])) {
      procedural += 2;
      add(breakdown, 'procedural', 2, 'No hearing before unpaid suspension strengthens the employee position', 'LRA s186(2)(b)');
    }
    return { substantive, procedural };
  }

  if (warningMatter) {
    substantive = 4;
    procedural = 4;
    if (hasAny(story, ['bereavement', 'death in the family', 'funeral', 'compassionate'])) { substantive += 2; add(breakdown, 'substantive', 2, 'Bereavement or compassionate context may provide a substantive defence to the warning', 'Schedule 8 Item 3'); }
    if (hasAny(story, ['delegated authority', 'acting manager', 'manager approved', 'authorised', 'permission'])) { substantive += 2; add(breakdown, 'substantive', 2, 'Delegated authority or approval may undermine the misconduct basis for the warning', 'Schedule 8 Item 3'); }
    if (hasAny(story, ['no hearing', 'not heard', 'no chance to explain', 'without asking me'])) { procedural += 3; add(breakdown, 'procedural', 3, 'No meaningful opportunity to respond before the warning', 'Schedule 8 Item 4'); }
    if (hasAny(story, ['final written warning', 'final warning'])) { substantive += 1; add(breakdown, 'substantive', 1, 'A final written warning raises proportionality concerns where the underlying facts are disputed', 'Schedule 8 Items 3 and 4'); }
    if (hasAny(story, ['appealed', 'appeal', 'grievance', 'emailed hr', 'raised internally'])) { procedural += 1; add(breakdown, 'procedural', 1, 'Internal challenge or escalation has been attempted', 'LRA s186(2)(c)'); }
    substantive += tenurePoint(facts, breakdown);
    return { substantive, procedural };
  }

  if (payMatter) {
    substantive = 5;
    procedural = 3;
    add(breakdown, 'substantive', 3, 'Monetary or statutory pay dispute identified', 'BCEA s34 / BCEA s77');
    if (hasAny(story, ['more than one month', 'two months', 'repeated', 'several months'])) { substantive += 2; add(breakdown, 'substantive', 2, 'Repeated or sustained non-payment strengthens the claim', 'BCEA s77'); }
    if (grievanceMatter) { procedural += 2; add(breakdown, 'procedural', 2, 'Internal escalation attempt recorded', 'BCEA enforcement / internal process'); }
    return { substantive, procedural };
  }

  if (grievanceMatter) {
    substantive = 3;
    procedural = 4;
    add(breakdown, 'procedural', 2, 'Internal grievance or escalation route has been identified', 'Internal process / LRA s186(2) where applicable');
    return { substantive, procedural };
  }

  add(breakdown, 'procedural', 1, 'Matter requires structured internal escalation before legal leverage can be confirmed', 'Internal process / LRA s186(2) where applicable');
  return { substantive, procedural };
}

function scoreByTrack(track, facts, breakdown) {
  const story = `${facts.initial_query || ''} ${facts.incident_description || ''}`;
  if (track === 'UD-MISCONDUCT') return scoreMisconduct(facts, breakdown, story);
  if (track === 'UD-POOR_PERFORMANCE') return scorePoorPerformance(facts, breakdown, story);
  if (track === 'UD-INCAPACITY') return scoreIncapacity(facts, breakdown, story);
  if (track === 'CD') return scoreConstructiveDismissal(facts, breakdown, story);
  if (track === 'AUD' || track === 'ULP') return scoreAudUlp(facts, breakdown, story);

  let substantive = 3, procedural = 3;
  if (track === 'UD-RETRENCHMENT') {
    if (hasAny(story, ['no s189', 'no section 189', 'no written notice'])) { procedural += 4; add(breakdown, 'procedural', 4, 'No written s189(3) notice appears to have been issued', 'LRA s189(3)'); }
    if (isNo(facts.proc_consultation) || hasAny(story, ['no consultation', 'brief consultation'])) { procedural += 3; add(breakdown, 'procedural', 3, 'Consultation appears inadequate', 'LRA s189'); }
    if (hasAny(story, ['unfair selection', 'selection criteria', 'last in first out', 'lifo'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Selection criteria may be unfair or undisclosed', 'LRA s189'); }
    if (hasAny(story, ['role refilled', 'replaced me', 'same role advertised', 'sham retrenchment'])) { substantive += 3; add(breakdown, 'substantive', 3, 'Facts may indicate a sham retrenchment', 'LRA s189'); }
  }
  if (track === 'PDA') {
    if (isNo(facts.proc_notice) || hasAny(story, ['less than 48 hours', 'same day notice', 'no charge sheet'])) { procedural += 3; add(breakdown, 'procedural', 3, 'Charge sheet or notice period appears defective', 'Schedule 8 Item 4'); }
    if (isNo(facts.proc_rep) || hasAny(story, ['no representative', 'not allowed representation'])) { procedural += 2; add(breakdown, 'procedural', 2, 'Representation may have been refused', 'Schedule 8 Item 4'); }
    if (facts.paid_suspension === false || hasAny(story, ['suspended without pay'])) { substantive += 5; add(breakdown, 'substantive', 5, 'Suspension without pay creates strong ULP leverage', 'LRA s186(2)(b)'); }
    substantive += tenurePoint(facts, breakdown);
  }
  if (track === 'ANC') return scoreAncillary(facts, breakdown, story);
  return { substantive, procedural };
}

function ancillarySubtype(facts = {}) {
  const topic = clean(facts.advisory_topic || facts.ancillary_topic);
  const story = clean(`${facts.initial_query || ''} ${facts.incident_description || ''}`);
  if (facts.paid_suspension === false || topic.includes('suspension') || hasAny(story, ['suspended without pay', 'suspension without pay'])) return 'SUSPENSION';
  if (topic.includes('warning') || topic.includes('e1') || hasAny(story, ['final written warning', 'written warning', 'warning challenge'])) return 'WARNING';
  if (topic.includes('pay') || topic.includes('bcea') || hasAny(story, ['unpaid', 'deduction', 'salary arrears', 'non-payment', 'not paid'])) return 'PAY';
  if (topic.includes('grievance') || hasAny(story, ['grievance', 'raised internally', 'emailed hr'])) return 'GRIEVANCE';
  return 'GENERAL';
}

function ancillaryLegalBasis(facts = {}) {
  const subtype = ancillarySubtype(facts);
  if (subtype === 'SUSPENSION') return ['LRA s186(2)(b)', 'LRA s186(2)(c)', 'Schedule 8 Item 4'];
  if (subtype === 'WARNING') return ['LRA s186(2)(c)', 'Schedule 8 Item 3', 'Schedule 8 Item 4'];
  if (subtype === 'PAY') return ['BCEA s34', 'BCEA s77'];
  if (subtype === 'GRIEVANCE') return ['Internal grievance procedure', 'LRA s186(2) where applicable'];
  return ['LRA s186(2) where applicable', 'Internal disciplinary or grievance procedure'];
}

function inferAncillaryOutput(facts = {}) {
  const subtype = ancillarySubtype(facts);
  if (subtype === 'SUSPENSION') return {
    title: 'Ancillary Advisory — Suspension Without Pay: ATTORNEY REVIEW', outputType: 'Advisory Note / Priority Review',
    bullets: ['Record the dates of suspension, the amount withheld and whether any notice or hearing was provided.', 'Preserve payslips, suspension notices, correspondence and proof of non-payment.', 'The matter may cross into unfair labour practice territory and should be reviewed by an attorney before any demand is sent.'],
    legalBasis: ancillaryLegalBasis(facts)
  };
  if (subtype === 'WARNING') return {
    title: 'Ancillary Advisory — Warning Challenge: PREPARATION PACK', outputType: 'Preparation Pack',
    bullets: ['Prepare a written response setting out your version of events and why the warning is unfair or disproportionate.', 'Check the employer\'s disciplinary code or internal appeal procedure for time limits and the correct person to send the appeal to.', 'Attach evidence that explains the absence, lateness or context, including bereavement or delegated-authority evidence where available.', 'If the warning causes prejudice or is used unfairly later, consider whether the matter reaches the unfair labour practice threshold.'],
    legalBasis: ancillaryLegalBasis(facts)
  };
  if (subtype === 'GRIEVANCE') return { title: 'Ancillary Advisory — Grievance Lodging: PREPARATION PACK', outputType: 'Preparation Pack', bullets: ['Prepare a written grievance setting out the conduct complained of, dates, people involved and the outcome requested.', 'Submit the grievance through the employer\'s internal procedure and keep proof of submission.', 'Escalate internally if the grievance is ignored or not resolved within the employer\'s stated process.'], legalBasis: ancillaryLegalBasis(facts) };
  if (subtype === 'PAY') return { title: 'Ancillary Advisory — Pay Dispute / BCEA Query: ADVISORY NOTE', outputType: 'Advisory Note', bullets: ['Calculate the amount in dispute and the period it relates to.', 'Send a written demand or query to payroll or HR with proof of the amount owed.', 'Consider Department of Labour, CCMA or other escalation depending on the nature of the pay dispute.'], legalBasis: ancillaryLegalBasis(facts) };
  return { title: 'Ancillary Advisory: PREPARATION PACK', outputType: 'Preparation Pack', bullets: ['Prepare a short written summary of the issue, dates, people involved and the outcome you want.', 'Use the employer\'s internal process first where appropriate.', 'Keep copies of all notices, warnings, emails, payslips and responses.'], legalBasis: ancillaryLegalBasis(facts) };
}

function buildAncillaryAdvisory(result, facts) {
  const output = inferAncillaryOutput(facts);
  const positives = result.scoring_breakdown.filter(x => x.points > 0).map(x => `- ${x.label} [${x.legalHook}]`).join('\n') || '- More structured facts are needed before the attorney can confirm leverage.';
  const risks = result.scoring_breakdown.filter(x => x.points < 0).map(x => `- ${x.label} [${x.legalHook}]`).join('\n') || '- No specific negative factor has been captured yet, but attorney review remains required before external action.';
  const legal = (result.legal_basis || output.legalBasis).map(x => `- ${x}`).join('\n');
  const steps = output.bullets.map(x => `- ${x}`).join('\n');
  return `${output.title}\n\nSubstantive Score: ${result.substantive_score} / 10\nThis score reflects the current strength of the employee's position on the substance of the warning, suspension, pay issue or advisory matter.\n\nProcedural Score: ${result.procedural_score} / 10\nThis score reflects the current strength of the employee's position on the process followed by the employer.\n\nFactors in your favour:\n${positives}\n\nRisks or weaknesses:\n${risks}\n\nOutput type: ${output.outputType}\n\nRecommended next step:\n${steps}\n\nWithout Prejudice letter status: NOT APPLICABLE unless attorney review confirms a Strategic Engagement Matrix exception or override trigger.\n\nLegal basis:\n${legal}\n\nAttorney review tag: PENDING`;
}

function buildAdvisory(result, facts) {
  if (result.track === 'ANC') return buildAncillaryAdvisory(result, facts);
  const positives = result.scoring_breakdown.filter(x => x.points > 0).map(x => `- ${x.label} [${x.legalHook}]`).join('\n') || '- No strong positive factors have been captured yet.';
  const risks = result.scoring_breakdown.filter(x => x.points < 0).map(x => `- ${x.label} [${x.legalHook}]`).join('\n') || '- More structured facts may be needed before an attorney can confirm the position.';
  const deadline = result.ccma_deadline_status.status === 'WITHIN_WINDOW' ? `${result.ccma_deadline_status.daysRemaining} days remaining in the ordinary 30-day CCMA referral window.` : result.ccma_deadline_status.status === 'LAPSED-CONDONATION' ? 'The ordinary 30-day CCMA referral window appears to have lapsed. Condonation may be required.' : 'The CCMA deadline cannot be confirmed because the relevant date is missing or invalid.';
  const legal = result.legal_basis.map(x => `- ${x}`).join('\n') || '- To be confirmed by attorney review.';
  const headlineMeritText = result.merit_band === 'NO MERIT' ? 'NO MERIT' : `${result.merit_band} MERIT`;
  if (result.hard_disqualifier) return `${result.track_label}: NO MERIT\n\nSubstantive Score: 0 / 10\nThe matter currently triggers a hard threshold issue: ${result.hard_disqualifier.name}.\n\nProcedural Score: 0 / 10\nNo procedural merit assessment is completed until this threshold issue is resolved.\n\nFactors in your favour:\n${positives}\n\nRisks or weaknesses:\n- ${result.hard_disqualifier.name} [${result.hard_disqualifier.legalBasis}]\n\nCCMA deadline status: ${deadline}\n\nRecommended next step: ${result.recommended_next_step}\n\nLegal basis:\n${legal}\n\nAttorney review tag: PENDING`;
  return `${result.track_label}: ${headlineMeritText}\n\nSubstantive Score: ${result.substantive_score} / 10\nThis score reflects the current strength of the employee's position on the reason for the employer's conduct or dismissal.\n\nProcedural Score: ${result.procedural_score} / 10\nThis score reflects the current strength of the employee's position on the process followed, or in constructive dismissal matters, the reasonableness of the employee's steps before resignation.\n\nFactors in your favour:\n${positives}\n\nRisks or weaknesses:\n${risks}\n\nCCMA deadline status: ${deadline}\n\nRecommended next step: ${result.recommended_next_step}\n\nLegal basis:\n${legal}\n\nAttorney review tag: PENDING${result.merit_bonus_trigger ? `\n\nPriority flag: ${result.merit_bonus_trigger.name} [${result.merit_bonus_trigger.legalBasis}]` : ''}`;
}

function scoreCase(facts = {}) {
  const track = inferTrack(facts);
  const breakdown = [];
  const hard = hardDisqualifier(facts, track);
  const bonus = meritBonus(facts, track);
  const deadline = ccmaStatus(facts);
  const raw = scoreByTrack(track, facts, breakdown);
  let substantive = clamp(raw.substantive), procedural = clamp(raw.procedural);
  if (hard) { substantive = 0; procedural = 0; }
  else if (bonus) { substantive = Math.max(substantive, 8); procedural = Math.max(procedural, 7); }
  const matrixTrack = track === 'ANC' && bonus ? 'ULP' : (track === 'ANC' ? 'ANC' : track);
  const recommendation = hard ? { band: 'NO MERIT', wpEligible: false, wpType: null, recommendation: 'Advisory note only. No WP letter until the hard disqualifier is resolved.' } : determineRecommendation(substantive, procedural, { track: matrixTrack });
  const legalBasis = track === 'ANC' ? ancillaryLegalBasis(facts) : (LEGAL_BASIS[track] || []);
  const result = { track, track_label: TRACK_LABELS[track] || track, substantive_score: substantive, procedural_score: procedural, merit_band: recommendation.band, recommended_next_step: recommendation.recommendation, wp_eligible: recommendation.wpEligible, wp_type: recommendation.wpType, ccma_deadline_status: deadline, hard_disqualifier: hard, merit_bonus_trigger: bonus, scoring_breakdown: breakdown, legal_basis: dedupe(legalBasis), attorney_review_flag: true };
  result.advisory_note = buildAdvisory(result, facts);
  return result;
}

module.exports = { scoreCase, inferTrack, ccmaStatus };