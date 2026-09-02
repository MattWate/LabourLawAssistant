const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const INTRO = `Hi, I am Justine, the VRS Labour Law Assistant. I will ask a series of questions to understand your situation and prepare it for review by the VRS legal team.\n\nMy automated assessment helps VRS understand your situation, but a VRS consultant will make any final decision about your matter. Type HELP at any time for assistance, or RESTART to begin again.`;

const choice = (label, value, next) => ({ label, value, next });
const buttons = (prompt, saveAs, choices) => ({ type: 'buttons', prompt, saveAs, choices });
const text = (prompt, saveAs, next, extra = {}) => ({ type: 'text', prompt, saveAs, next, ...extra });
const date = (prompt, saveAs, next) => ({ type: 'date', prompt, saveAs, next });

const STEPS = {
  JUR_EMPLOYEE: buttons('Hi, my name is Justine and I am a VRS Labour Law Assistant. I am here to help you work through what has happened. To start, are you employed by the company, rather than working for yourself as a freelancer or contractor?', 'worker_status', [
    choice('Yes', 'Employee', 'JUR_SA_EMPLOYER'), choice('No', 'Contractor', 'JUR_CONTRACTOR_CONTROL'), choice('Unsure', 'Unsure', 'JUR_CONTRACTOR_CONTROL')
  ]),
  JUR_CONTRACTOR_CONTROL: buttons('Does someone tell you when to start work, when to stop work, and how to do the work?', 'contractor_control_test', [
    choice('Yes', 'yes', 'JUR_SA_EMPLOYER'), choice('No', 'no', 'DEFLECT_CONTRACTOR')
  ]),
  JUR_SA_EMPLOYER: buttons('Does your employer operate or do business in South Africa?', 'south_african_employer', [
    choice('Yes', 'yes', 'JUR_PUBLIC_SERVICE'), choice('No', 'no', 'DEFLECT_CROSS_BORDER'), choice('Unsure', 'unsure', 'JUR_PUBLIC_SERVICE')
  ]),
  JUR_PUBLIC_SERVICE: buttons('Do you work for a government department or state entity, for example the Department of Labour, Health, Public Works, SAPS or the SANDF?', 'public_service_or_excluded_agency', [
    choice('Yes', 'yes', 'DEFLECT_PUBLIC_SERVICE'), choice('No', 'no', 'START'), choice('Unsure', 'unsure', 'JUR_SOE')
  ]),
  JUR_SOE: buttons('Are you a Schedule 2 SOE employee whose dispute remains CCMA-eligible?', 'schedule_2_soe_ccma_eligible', [
    choice('Yes', 'yes', 'START'), choice('No', 'no', 'START'), choice('Unclear', 'unclear', 'DEFLECT_SOE_UNCLEAR')
  ]),

  START: { type: 'classify', prompt: 'Please tell me what has happened at work and what you would like help with. There is no right or wrong way to explain it. Just tell me in your own words.' },
  START_FALLBACK: buttons('Which option best describes what happened?', 'employment_status', [
    choice('I was fired or dismissed', 'Dismissed', 'FIRED_DATE'),
    choice('I was forced to resign', 'Resigned', 'RESIGN_DATE'),
    choice('I am facing discrimination', 'Discrimination', 'DISC_STATUS'),
    choice('I am still employed and need advice', 'Advisory', 'ADV_ISSUE'),
    choice('I need help with UIF', 'UIF', 'UIF_DESC')
  ]),

  FIRED_DATE: date('What was the exact date of your dismissal? Please use YYYY-MM-DD or DD/MM/YYYY.', 'incident_date', 'FIRED_REASON_TYPE'),
  FIRED_REASON_TYPE: buttons('What was the stated reason given for your dismissal?', 'dismissal_reason_type', [
    choice('Misconduct', 'Misconduct', 'A2_MISCONDUCT_CATEGORY'),
    choice('Poor performance', 'Poor Performance', 'P2_PERFORMANCE_STANDARDS'),
    choice('Incapacity, illness or injury', 'Incapacity', 'I2_INCAPACITY_NATURE'),
    choice('Retrenchment or operational requirements', 'Retrenchment', 'R2_HEADCOUNT'),
    choice('Other', 'Other', 'FIRED_REASON_OTHER_EXPLANATION')
  ]),
  FIRED_REASON_OTHER_EXPLANATION: text('Please explain the reason your employer gave for dismissing you.', 'dismissal_reason_other_explanation', 'COMPANY_NAME', { minWords: 3 }),

  A2_MISCONDUCT_CATEGORY: buttons('What did your employer say you had done wrong?', 'misconduct_category', [
    choice('Theft', 'theft', 'A3_CONDUCT_ADMISSION'), choice('Assault', 'assault', 'A3_CONDUCT_ADMISSION'),
    choice('Dishonesty', 'dishonesty', 'A3_CONDUCT_ADMISSION'), choice('Insubordination', 'insubordination', 'A3_CONDUCT_ADMISSION'),
    choice('Absenteeism', 'absenteeism', 'A3_CONDUCT_ADMISSION'), choice('Other', 'other', 'A3_CONDUCT_ADMISSION')
  ]),
  A3_CONDUCT_ADMISSION: buttons('Do you agree with what your employer says happened, or do you dispute it?', 'conduct_admission', [
    choice('Admit', 'Admit', 'A4_HEARING_HELD'), choice('Dispute', 'Dispute', 'A4_HEARING_HELD'), choice('Partially admit', 'Partially admit', 'A4_HEARING_HELD')
  ]),
  A4_HEARING_HELD: buttons('Did your employer hold a disciplinary hearing before dismissing you?', 'hearing_held', [
    choice('Yes', true, 'A5_NOTICE'), choice('No', false, 'A8_PRIOR_WARNINGS')
  ]),
  A5_NOTICE: buttons('Before the hearing, were you given written notice and told what the charges were at least 48 hours beforehand?', 'proc_notice', [
    choice('Yes', true, 'A6_REPRESENTATIVE'), choice('No', false, 'A6_REPRESENTATIVE'), choice('Unsure', 'unsure', 'A6_REPRESENTATIVE')
  ]),
  A6_REPRESENTATIVE: buttons('Were you allowed to have a colleague or trade union representative with you at the hearing?', 'proc_rep', [
    choice('Yes', true, 'A7_CHAIRPERSON'), choice('No', false, 'A7_CHAIRPERSON')
  ]),
  A7_CHAIRPERSON: buttons('Was the person chairing the hearing independent, rather than someone directly involved in the issue?', 'proc_chair', [
    choice('Yes', true, 'A8_PRIOR_WARNINGS'), choice('No', false, 'A8_PRIOR_WARNINGS'), choice('Unsure', 'unsure', 'A8_PRIOR_WARNINGS')
  ]),
  A8_PRIOR_WARNINGS: buttons('Before this happened, had you received any written warnings for the same or a similar issue?', 'prior_warnings', [
    choice('None', 'None', 'A9_EMPLOYMENT_LENGTH'), choice('One', 'One', 'A9_EMPLOYMENT_LENGTH'), choice('Multiple', 'Multiple', 'A9_EMPLOYMENT_LENGTH')
  ]),
  A9_EMPLOYMENT_LENGTH: buttons('How long had you been employed?', 'length_of_service', serviceChoices('A10_SALARY')),
  A10_SALARY: text('What was your gross monthly salary?', 'gross_monthly_salary', 'A11_MISCONDUCT_NARRATIVE'),
  A11_MISCONDUCT_NARRATIVE: text('In your own words, describe what happened leading up to your dismissal.', 'incident_description', 'COMPANY_NAME', { minWords: 20 }),

  P2_PERFORMANCE_STANDARDS: buttons('Before this happened, had your employer clearly explained what was expected of you in your role?', 'performance_standards_communicated', yesNoUnclear('P3_PIP')),
  P3_PIP: buttons('Were you given a proper chance to improve, for example a formal Performance Improvement Plan, before anything happened?', 'pip_given', [
    choice('Yes', true, 'P4_PIP_DURATION'), choice('No', false, 'P5_TRAINING')
  ]),
  P4_PIP_DURATION: buttons('How long was the improvement period?', 'pip_duration', [
    choice('Less than 2 weeks', '<2 weeks', 'P5_TRAINING'), choice('2 to 4 weeks', '2-4 weeks', 'P5_TRAINING'), choice('1 to 3 months', '1-3 months', 'P5_TRAINING'), choice('More than 3 months', '3+ months', 'P5_TRAINING')
  ]),
  P5_TRAINING: buttons('Did your employer give you training, guidance or support to help you improve?', 'training_provided', [
    choice('Yes', true, 'P6_COMPARATORS'), choice('No', false, 'P6_COMPARATORS'), choice('Inadequate', 'Inadequate', 'P6_COMPARATORS')
  ]),
  P6_COMPARATORS: buttons('Were other people on your team meeting the same targets or standards you were measured against?', 'team_meeting_standards', [
    choice('Yes', 'Yes', 'P7_CONTROL'), choice('No', 'No', 'P7_CONTROL'), choice('Unsure', 'Unsure', 'P7_CONTROL'), choice('Unable to compare', 'Unable to compare', 'P7_CONTROL')
  ]),
  P7_CONTROL: buttons('Do you feel the targets were realistic and achievable, or were there things outside your control making them harder to reach, like equipment issues, understaffing or workload?', 'performance_control', [
    choice('Within my control', 'Within my control', 'P8_PERFORMANCE_WARNINGS'), choice('External factors', 'External factors', 'P8_PERFORMANCE_WARNINGS'), choice('Both', 'Both', 'P8_PERFORMANCE_WARNINGS')
  ]),
  P8_PERFORMANCE_WARNINGS: buttons('Before this happened, had you received any warnings about your performance?', 'prior_performance_warnings', [
    choice('None', 'None', 'P9_EMPLOYMENT_LENGTH'), choice('One', 'One', 'P9_EMPLOYMENT_LENGTH'), choice('Multiple', 'Multiple', 'P9_EMPLOYMENT_LENGTH')
  ]),
  P9_EMPLOYMENT_LENGTH: buttons('How long had you been employed?', 'length_of_service', serviceChoices('P10_SALARY')),
  P10_SALARY: text('What was your gross monthly salary?', 'gross_monthly_salary', 'P11_PERFORMANCE_NARRATIVE'),
  P11_PERFORMANCE_NARRATIVE: text('In your own words, tell me what concerns were raised about your performance and what happened next.', 'incident_description', 'COMPANY_NAME', { minWords: 20 }),

  I2_INCAPACITY_NATURE: buttons('What was the nature of your incapacity?', 'incapacity_nature', [
    choice('Illness', 'Illness', 'I3_INCAPACITY_DURATION'), choice('Injury', 'Injury', 'I3_INCAPACITY_DURATION'), choice('Disability', 'Disability', 'I3_INCAPACITY_DURATION'), choice('Mental health', 'Mental health', 'I3_INCAPACITY_DURATION')
  ]),
  I3_INCAPACITY_DURATION: buttons('Was your incapacity temporary or permanent at the time of dismissal?', 'incapacity_duration', [
    choice('Temporary', 'Temporary', 'I4_CONSULTATION'), choice('Permanent', 'Permanent', 'I4_CONSULTATION'), choice('Uncertain', 'Uncertain', 'I4_CONSULTATION')
  ]),
  I4_CONSULTATION: buttons('Did your employer formally consult with you about the extent of your illness or injury?', 'proc_consultation', [
    choice('Yes', true, 'I5_MEDICAL_REPORTS'), choice('No', false, 'I5_MEDICAL_REPORTS'), choice('Brief meeting only', 'Brief meeting only', 'I5_MEDICAL_REPORTS')
  ]),
  I5_MEDICAL_REPORTS: buttons('Did the employer review medical reports or speak to your practitioner?', 'medical_review', [
    choice('Yes', true, 'I6_ALTERNATIVES'), choice('No', false, 'I6_ALTERNATIVES'), choice('I was not asked for evidence', 'I was not asked to provide medical evidence', 'I6_ALTERNATIVES')
  ]),
  I6_ALTERNATIVES: buttons('Did the employer explore adapted duties, another role, reduced hours or more recovery time?', 'alternatives_explored', yesNoUnclear('I7_STATE_CASE')),
  I7_STATE_CASE: buttons('Were you given an opportunity to state your case, with representation if desired?', 'opportunity_to_state_case', yesNo('I8_EMPLOYMENT_LENGTH')),
  I8_EMPLOYMENT_LENGTH: buttons('How long had you been employed?', 'length_of_service', serviceChoices('I9_SALARY')),
  I9_SALARY: text('What was your gross monthly salary?', 'gross_monthly_salary', 'I10_INCAPACITY_NARRATIVE'),
  I10_INCAPACITY_NARRATIVE: text('Describe the circumstances of your illness or injury and how the dismissal came about.', 'incident_description', 'COMPANY_NAME'),

  R2_HEADCOUNT: buttons('How many other employees were retrenched at the same time?', 'retrenchment_headcount', [
    choice('Just me', 'Just me', 'R3_S189_NOTICE'), choice('2 to 9', '2-9', 'R3_S189_NOTICE'), choice('10 or more', '10+', 'R3_S189_NOTICE'), choice('Unsure', 'Unsure', 'R3_S189_NOTICE')
  ]),
  R3_S189_NOTICE: buttons('Did the employer issue a written section 189(3) notice?', 's189_notice', yesNoUnclear('R4_CONSULTATION')),
  R4_CONSULTATION: buttons('Did the employer engage in meaningful consultation before the final decision?', 'retrenchment_consultation', [
    choice('Yes', 'Yes', 'R5_SELECTION_CRITERIA'), choice('Brief consultation', 'Brief', 'R5_SELECTION_CRITERIA'), choice('No consultation', 'No consultation', 'R5_SELECTION_CRITERIA')
  ]),
  R5_SELECTION_CRITERIA: buttons('Were the selection criteria objective and disclosed in writing?', 'selection_criteria_objective', yesNoUnclear('R6_ALTERNATIVES')),
  R6_ALTERNATIVES: buttons('Did the employer offer alternatives such as redeployment or short time?', 'retrenchment_alternatives', yesNo('R7_SEVERANCE')),
  R7_SEVERANCE: buttons('Were you offered at least one week of severance pay per completed year of service?', 'severance_pay', [
    choice('Yes', 'Yes', 'R8_OPERATIONAL_REASON'), choice('Less', 'Less', 'R8_OPERATIONAL_REASON'), choice('No', 'No', 'R8_OPERATIONAL_REASON')
  ]),
  R8_OPERATIONAL_REASON: buttons('Did the operational reason given seem genuine and plausible?', 'operational_reason_plausible', [
    choice('Yes', 'Yes', 'R9_ROLE_REFILLED'), choice('I doubt it', 'I doubt it', 'R9_ROLE_REFILLED'), choice('I cannot know', 'I have no way to know', 'R9_ROLE_REFILLED')
  ]),
  R9_ROLE_REFILLED: buttons('Has your role or a similar role been filled again by the employer or a related company?', 'role_refilled', [
    choice('Yes', 'Yes', 'R10_SALARY_DURATION'), choice('No', 'No', 'R10_SALARY_DURATION'), choice('I do not know', 'I do not know', 'R10_SALARY_DURATION')
  ]),
  R10_SALARY_DURATION: text('What was your gross monthly salary, and how long were you employed?', 'gross_monthly_salary_and_duration', 'R11_RETRENCHMENT_NARRATIVE'),
  R11_RETRENCHMENT_NARRATIVE: text('In your own words, describe the retrenchment process.', 'incident_description', 'COMPANY_NAME', { minWords: 20 }),

  RESIGN_DATE: date('What was the date you officially resigned?', 'incident_date', 'B2_INTOLERABLE_CONDUCT'),
  B2_INTOLERABLE_CONDUCT: buttons('What conduct made your working environment intolerable?', 'intolerable_conduct', [
    choice('Demotion', 'demotion', 'B3_DURATION'), choice('Salary reduction or non-payment', 'salary reduction or non-payment', 'B3_DURATION'),
    choice('Harassment or bullying', 'harassment or bullying', 'B3_DURATION'), choice('Discrimination', 'discrimination', 'B3_DURATION'),
    choice('Unsafe conditions', 'unsafe conditions', 'B3_DURATION'), choice('Victimisation after grievance', 'victimisation after grievance', 'B3_DURATION'),
    choice('Unilateral contract change', 'unilateral contract change', 'B3_DURATION'), choice('Other', 'other', 'B3_DURATION')
  ]),
  B3_DURATION: buttons('How long were these conditions ongoing before you resigned?', 'intolerable_duration', [
    choice('Less than 1 month', '<1 month', 'B4_GRIEVANCE'), choice('1 to 3 months', '1-3 months', 'B4_GRIEVANCE'), choice('3 to 6 months', '3-6 months', 'B4_GRIEVANCE'), choice('More than 6 months', '6+ months', 'B4_GRIEVANCE')
  ]),
  B4_GRIEVANCE: buttons('Did you formally raise a grievance before resigning?', 'grievance_raised', [
    choice('Yes, in writing', 'Yes, in writing', 'B6_EMPLOYER_ACTION'), choice('Yes, verbally', 'Yes, verbally', 'B6_EMPLOYER_ACTION'), choice('No', 'No', 'B5_NO_GRIEVANCE_REASON')
  ]),
  B5_NO_GRIEVANCE_REASON: buttons('Why did you not raise a grievance?', 'no_grievance_reason', [
    choice('I did not know I could', 'Did not know I could', 'B6_EMPLOYER_ACTION'), choice('I feared retaliation', 'Feared retaliation', 'B6_EMPLOYER_ACTION'),
    choice('The conduct was too severe', 'Conduct was so severe that grievance was futile', 'B6_EMPLOYER_ACTION'), choice('The employer was the perpetrator', 'Employer is the alleged perpetrator', 'B6_EMPLOYER_ACTION'), choice('Other', 'Other', 'B6_EMPLOYER_ACTION')
  ]),
  B6_EMPLOYER_ACTION: buttons('Did the employer take action to address your concerns?', 'employer_response', [
    choice('No action', 'No action', 'B7_WAIT_PERIOD'), choice('Partial action', 'Partial', 'B7_WAIT_PERIOD'), choice('Full resolution', 'Full resolution', 'B7_WAIT_PERIOD')
  ]),
  B7_WAIT_PERIOD: buttons('How long after raising the grievance did you wait before resigning?', 'wait_after_grievance', [
    choice('Did not raise one', 'Did not raise', 'B8_COLLEAGUES'), choice('Less than 2 weeks', '<2 weeks', 'B8_COLLEAGUES'), choice('2 to 4 weeks', '2-4 weeks', 'B8_COLLEAGUES'), choice('1 to 3 months', '1-3 months', 'B8_COLLEAGUES'), choice('More than 3 months', '3+ months', 'B8_COLLEAGUES')
  ]),
  B8_COLLEAGUES: buttons('Did colleagues witness or experience similar treatment?', 'colleagues_witnessed', yesNoUnclear('B9_SALARY')),
  B9_SALARY: text('What was your gross monthly salary?', 'gross_monthly_salary', 'B10_NARRATIVE'),
  B10_NARRATIVE: text('Describe what made the working conditions intolerable.', 'incident_description', 'COMPANY_NAME', { minWords: 20 }),

  DISC_STATUS: buttons('Are you still employed, dismissed, or did you resign?', 'disc_status', [
    choice('Still employed', 'Still employed', 'C2_PROTECTED_GROUND'), choice('Dismissed', 'Dismissed', 'C2_PROTECTED_GROUND'), choice('Resigned', 'Resigned', 'RESIGN_DATE')
  ]),
  C2_PROTECTED_GROUND: buttons('Which protected ground do you believe was the basis of the treatment?', 'protected_ground', [
    choice('Race', 'race', 'C3_COMPARATOR'), choice('Gender', 'gender', 'C3_COMPARATOR'), choice('Pregnancy', 'pregnancy', 'C3_COMPARATOR'),
    choice('Sexual orientation', 'sexual orientation', 'C3_COMPARATOR'), choice('Disability', 'disability', 'C3_COMPARATOR'), choice('HIV status', 'HIV status', 'C3_COMPARATOR'),
    choice('Religion', 'religion', 'C3_COMPARATOR'), choice('Age', 'age', 'C3_COMPARATOR'), choice('Political opinion', 'political opinion', 'C3_COMPARATOR'),
    choice('Union activity', 'union activity', 'C3_COMPARATOR'), choice('Whistleblowing', 'whistleblowing', 'C3_COMPARATOR'), choice('Other', 'other', 'C3_COMPARATOR')
  ]),
  C3_COMPARATOR: buttons('Can you identify another employee in a similar role who was treated differently?', 'protected_ground_comparator', yesNoUnclear('C4_REPORTED')),
  C4_REPORTED: buttons('Did you formally report the discrimination or unfair treatment?', 'protected_ground_reported', [
    choice('Yes, in writing', 'Yes, in writing', 'C5_WORSENED'), choice('Yes, verbally', 'Yes, verbally', 'C5_WORSENED'), choice('No', 'No', 'C5_WORSENED')
  ]),
  C5_WORSENED: buttons('Did the employer response worsen your situation after you reported it?', 'employer_response_worsened', [
    choice('Yes', 'Yes', 'C6_LENGTH'), choice('No', 'No', 'C6_LENGTH'), choice('No response', 'No response', 'C6_LENGTH')
  ]),
  C6_LENGTH: text('How long have you worked for this employer?', 'length_of_service', 'C7_SALARY'),
  C7_SALARY: text('What is or was your gross monthly salary?', 'gross_monthly_salary', 'C8_NARRATIVE'),
  C8_NARRATIVE: text('Describe what happened, including incidents, approximate dates and named individuals.', 'incident_description', 'COMPANY_NAME', { minWords: 25 }),

  ADV_ISSUE: buttons('What specific issue do you need help with?', 'advisory_topic', [
    choice('Warning', 'Warning', 'E2_EMPLOYMENT_LENGTH'), choice('Grievance', 'Grievance', 'E2_EMPLOYMENT_LENGTH'), choice('Hearing preparation', 'Hearing Prep', 'D1_HEARING_DATE'),
    choice('BCEA query', 'BCEA query', 'E2_EMPLOYMENT_LENGTH'), choice('Reference letter', 'Reference letter', 'E2_EMPLOYMENT_LENGTH'), choice('Pay dispute', 'Pay dispute', 'E2_EMPLOYMENT_LENGTH'), choice('Other', 'Other', 'E2_EMPLOYMENT_LENGTH')
  ]),
  D1_HEARING_DATE: date('When is your disciplinary hearing scheduled?', 'hearing_date', 'D2_CHARGE_SHEET'),
  D2_CHARGE_SHEET: buttons('Have you received a written charge sheet detailing the allegations?', 'charge_sheet_received', yesNo('D3_48H_NOTICE')),
  D3_48H_NOTICE: buttons('Does the charge sheet give you at least 48 hours notice?', 'proc_notice', [
    choice('Yes', true, 'D4_SUSPENSION'), choice('No', false, 'D4_SUSPENSION'), choice('Postponed already', 'Postponed already', 'D4_SUSPENSION')
  ]),
  D4_SUSPENSION: buttons('Have you been suspended pending the hearing?', 'paid_suspension', [
    choice('Yes, with pay', 'Yes, with pay', 'D5_REPRESENTATION'), choice('Yes, without pay', 'Yes, without pay', 'D5_REPRESENTATION'), choice('No', 'No', 'D5_REPRESENTATION')
  ]),
  D5_REPRESENTATION: buttons('Have you been offered the right to bring a union representative or colleague?', 'proc_rep', [
    choice('Yes', true, 'D6_ALLEGATION_NATURE'), choice('No', false, 'D6_ALLEGATION_NATURE'), choice('Not told', 'Not told either way', 'D6_ALLEGATION_NATURE')
  ]),
  D6_ALLEGATION_NATURE: buttons('What is the nature of the allegation?', 'allegation_nature', [
    choice('Theft', 'theft', 'D7_PRIOR_WARNINGS'), choice('Assault', 'assault', 'D7_PRIOR_WARNINGS'), choice('Dishonesty', 'dishonesty', 'D7_PRIOR_WARNINGS'),
    choice('Insubordination', 'insubordination', 'D7_PRIOR_WARNINGS'), choice('Absenteeism', 'absenteeism', 'D7_PRIOR_WARNINGS'), choice('Other', 'other', 'D7_PRIOR_WARNINGS')
  ]),
  D7_PRIOR_WARNINGS: buttons('Have you received prior warnings for similar conduct?', 'prior_warnings', [
    choice('None', 'None', 'D8_EMPLOYMENT_LENGTH'), choice('One', 'One', 'D8_EMPLOYMENT_LENGTH'), choice('Multiple', 'Multiple', 'D8_EMPLOYMENT_LENGTH')
  ]),
  D8_EMPLOYMENT_LENGTH: buttons('How long have you been employed?', 'length_of_service', serviceChoices('D9_PDA_NARRATIVE')),
  D9_PDA_NARRATIVE: text('Describe the allegation and your version of events.', 'incident_description', 'COMPANY_NAME'),

  E2_EMPLOYMENT_LENGTH: buttons('How long have you been employed?', 'length_of_service', serviceChoices('E3_RELEVANT_EVENT_DATE')),
  E3_RELEVANT_EVENT_DATE: date('What is the date of the relevant event?', 'relevant_event_date', 'E4_INTERNAL_RAISED'),
  E4_INTERNAL_RAISED: buttons('Have you raised this internally yet?', 'raised_internally', [
    choice('Yes', 'Yes', 'E5_SALARY'), choice('No', 'No', 'E5_SALARY'), choice('Started but not finished', 'Started but not finished', 'E5_SALARY')
  ]),
  E5_SALARY: text('What is your gross monthly salary?', 'gross_monthly_salary', 'E6_ANCILLARY_NARRATIVE'),
  E6_ANCILLARY_NARRATIVE: text('Describe the situation in your own words.', 'incident_description', 'COMPANY_NAME'),
  UIF_DESC: text('Briefly describe your UIF query and how you need help.', 'incident_description', 'COMPANY_NAME'),

  COMPANY_NAME: text('What is the name of the company you work for, or worked for?', 'employer_name', 'COMPANY_CONTACT'),
  COMPANY_CONTACT: text('Could you share a contact email or number for your employer's HR department or your manager? This just helps us know where to send correspondence. Type UNKNOWN if you do not have it.', 'employer_contact_details', 'CLIENT_NAME'),
  CLIENT_NAME: text('Almost done. What is your full name?', 'client_name', 'HANDOFF'),
  HANDOFF: { type: 'evaluate' }
};

function serviceChoices(next) {
  return [choice('Less than 6 months', '<6 months', next), choice('6 months to 2 years', '6m-2y', next), choice('2 to 5 years', '2-5y', next), choice('More than 5 years', '5 years', next)];
}
function yesNo(next) { return [choice('Yes', true, next), choice('No', false, next)]; }
function yesNoUnclear(next) { return [choice('Yes', true, next), choice('No', false, next), choice('Unsure or unclear', 'Unclear', next)]; }

const DEFLECTIONS = {
  DEFLECT_CONTRACTOR: 'Your answers suggest that this may fall outside ordinary employee protections. Civil contract advice may be required before a labour-law merits assessment.',
  DEFLECT_CROSS_BORDER: 'This matter may require cross-border or international employment advice before a South African labour-law assessment.',
  DEFLECT_PUBLIC_SERVICE: 'This matter should be triaged to the correct public-sector forum or bargaining council.',
  DEFLECT_SOE_UNCLEAR: 'Attorney review is required to confirm CCMA eligibility or the correct bargaining council or forum.'
};

function cleanText(value = '') { return String(value || '').trim(); }
function renderPrompt(stepName) {
  const step = STEPS[stepName];
  if (!step?.prompt) return null;
  if (step.type !== 'buttons') return step.prompt;
  return `${step.prompt}\n\n${step.choices.map((item, index) => `${index + 1}. ${item.label}`).join('\n')}`;
}
function normalize(value = '') {
  return cleanText(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9+<>\- ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function matchChoice(input, step) {
  const normalized = normalize(input);
  const number = Number.parseInt(normalized, 10);
  if (Number.isInteger(number) && String(number) === normalized && step.choices[number - 1]) return step.choices[number - 1];
  let match = step.choices.find(item => normalize(item.label) === normalized || normalize(String(item.value)) === normalized);
  if (match) return match;
  match = step.choices.find(item => normalized.includes(normalize(item.label)) || normalize(item.label).includes(normalized));
  if (match) return match;
  if (['yes', 'y', 'yeah', 'yep'].includes(normalized)) return step.choices.find(item => normalize(item.label) === 'yes');
  if (['no', 'n', 'nope'].includes(normalized)) return step.choices.find(item => normalize(item.label) === 'no');
  if (['unsure', 'not sure', 'unclear', 'i dont know'].includes(normalized)) return step.choices.find(item => /unsure|unclear/i.test(item.label));
  return null;
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(value);
}
function wordCount(value) { return cleanText(value).split(/\s+/).filter(Boolean).length; }

async function invokeAsk(action, payload) {
  const { handler } = require('../ask');
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ action, ...payload }) });
  const body = JSON.parse(result.body || '{}');
  if (result.statusCode >= 400) throw new Error(body.error || body.message || `Assessment failed with status ${result.statusCode}`);
  return body;
}
async function getConversation(fromNumber) {
  const { data, error } = await supabase.from('whatsapp_conversations').select('*').eq('from_number', fromNumber).maybeSingle();
  if (error) throw error;
  return data;
}
async function createConversation(message) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('whatsapp_conversations').insert({
    from_number: message.from_number, contact_name: message.contact_name || null, phone_number_id: message.phone_number_id || null,
    current_step: 'JUR_EMPLOYEE', status: 'active',
    collected_facts: { client_name: message.contact_name || null, contact_info: message.from_number, source: 'whatsapp' },
    processed_message_ids: message.whatsapp_message_id ? [message.whatsapp_message_id] : [], last_inbound_at: now, updated_at: now
  }).select().single();
  if (error) throw error;
  return data;
}
async function updateConversation(id, patch) {
  const { data, error } = await supabase.from('whatsapp_conversations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
function appendMessageId(conversation, messageId) {
  const ids = Array.isArray(conversation.processed_message_ids) ? conversation.processed_message_ids : [];
  if (!messageId || ids.includes(messageId)) return ids;
  return [...ids.slice(-49), messageId];
}
async function markHandoff(conversation, message, reason, facts = {}) {
  const issueSummary = DEFLECTIONS[reason] || 'WhatsApp intake requires human review.';
  const { data: caseRow, error } = await supabase.from('cases').insert({
    client_name: facts.client_name || conversation.contact_name || 'WhatsApp enquiry', contact_info: conversation.from_number,
    issue_summary: issueSummary, case_facts: { ...facts, source: 'whatsapp', jurisdiction_outcome: reason, attorney_review_flag: true },
    status: 'jurisdiction_triage', letter_status: 'not_applicable'
  }).select().single();
  if (error) throw error;
  await updateConversation(conversation.id, { status: 'handoff', current_step: reason, handoff_reason: reason, case_id: caseRow.id,
    collected_facts: facts, processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id), last_inbound_at: new Date().toISOString() });
  return `${issueSummary}\n\nReference: ${caseRow.id}`;
}
async function restartConversation(conversation, message) {
  const facts = { client_name: message.contact_name || conversation.contact_name || null, contact_info: message.from_number, source: 'whatsapp' };
  await updateConversation(conversation.id, { current_step: 'JUR_EMPLOYEE', status: 'active', collected_facts: facts, classification: null,
    case_id: null, handoff_reason: null, error_message: null, processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id), last_inbound_at: new Date().toISOString() });
  return `${INTRO}\n\n${renderPrompt('JUR_EMPLOYEE')}`;
}
const AI_SKIP_CONFIDENCE = Number(process.env.WHATSAPP_AI_SKIP_CONFIDENCE || 0.8);

function hasValue(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

function choiceForStoredValue(step, value) {
  if (!step || step.type !== 'buttons' || !hasValue(value)) return null;
  const wanted = normalize(String(value));
  return step.choices.find(item => normalize(String(item.value)) === wanted || normalize(item.label) === wanted) || null;
}

function stepIsAnswered(step, facts = {}) {
  if (!step?.saveAs || !hasValue(facts[step.saveAs])) return false;
  const value = facts[step.saveAs];
  const meta = facts._fact_metadata?.[step.saveAs];
  if (meta?.source === 'initial_narrative_ai' && Number(meta.confidence || 0) < AI_SKIP_CONFIDENCE) return false;
  if (step.type === 'date') return validDate(String(value));
  if (step.type === 'buttons') return Boolean(choiceForStoredValue(step, value));
  if (step.minWords) return wordCount(String(value)) >= step.minWords;
  return true;
}

function resolveNextUnanswered(stepName, facts = {}) {
  let current = stepName;
  const visited = new Set();
  for (let i = 0; i < 60 && current; i += 1) {
    if (visited.has(current) || DEFLECTIONS[current] || current === 'HANDOFF') return current;
    visited.add(current);
    const step = STEPS[current];
    if (!step || step.type === 'classify' || step.type === 'evaluate' || !stepIsAnswered(step, facts)) return current;
    if (step.type === 'buttons') {
      const selected = choiceForStoredValue(step, facts[step.saveAs]);
      if (!selected) return current;
      current = selected.next;
    } else {
      current = step.next;
    }
  }
  return current || 'HANDOFF';
}

function mergeNarrativeFacts(facts = {}, classification = {}) {
  const governance = classification.governance || {};
  const hydrated = classification.hydrated_facts || governance.hydrated_facts || {};
  const confidenceByField = governance.confidence_per_field || classification.confidence_per_field || {};
  const metadata = { ...(facts._fact_metadata || {}) };
  const merged = { ...facts };

  const candidates = { ...hydrated };
  const overallConfidence = Number(governance.confidence ?? classification.confidence ?? 0);
  if (!hasValue(candidates.employment_status) && hasValue(classification.category)) candidates.employment_status = classification.category;
  if (!hasValue(candidates.dismissal_reason_type) && hasValue(classification.dismissal_reason_type)) candidates.dismissal_reason_type = classification.dismissal_reason_type;
  if (!hasValue(candidates.advisory_topic) && hasValue(classification.advisory_topic)) candidates.advisory_topic = classification.advisory_topic;

  Object.entries(candidates).forEach(([key, value]) => {
    if (!hasValue(value) || hasValue(merged[key])) return;
    const confidence = Number(confidenceByField[key] ?? overallConfidence ?? 0);
    if (confidence < AI_SKIP_CONFIDENCE) return;
    merged[key] = value;
    metadata[key] = { source: 'initial_narrative_ai', confidence, captured_at: new Date().toISOString() };
  });

  merged._fact_metadata = metadata;
  merged.ai_extracted_fields = Object.keys(metadata).filter(key => metadata[key]?.source === 'initial_narrative_ai');
  return merged;
}

function markDirectAnswer(facts, key) {
  if (!key) return facts;
  return {
    ...facts,
    _fact_metadata: {
      ...(facts._fact_metadata || {}),
      [key]: { source: 'user_answer', confidence: 1, captured_at: new Date().toISOString() }
    }
  };
}

function routeClassification(classification = {}) {
  const category = classification.category || classification.employment_status || 'Ambiguous';
  if (category === 'Dismissed') return 'FIRED_DATE';
  if (category === 'Resigned') return 'RESIGN_DATE';
  if (category === 'Discrimination') return 'DISC_STATUS';
  if (category === 'Advisory') return classification.advisory_topic === 'Hearing Prep' ? 'D1_HEARING_DATE' : 'ADV_ISSUE';
  if (category === 'UIF') return 'UIF_DESC';
  return 'START_FALLBACK';
}
async function completeEvaluation(conversation, message, facts) {
  const finalFacts = { ...facts, contact_info: conversation.from_number, source: 'whatsapp' };
  const evaluation = await invokeAsk('evaluate', { facts: finalFacts });
  await updateConversation(conversation.id, { status: 'completed', current_step: 'COMPLETE', collected_facts: finalFacts, case_id: evaluation.caseId,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id), last_inbound_at: new Date().toISOString() });
  const assessment = evaluation.pitch || evaluation.scorecard?.recommended_next_step || 'Your enquiry has been recorded for review.';
  return `Thank you. I have created your confidential VRS intake and sent it for legal review.\n\nInitial assessment:\n${assessment}\n\nReference: ${evaluation.caseId}`;
}
async function processIncomingMessage(message) {
  if (!supabase) throw new Error('Supabase is not configured for WhatsApp conversation state');
  const input = cleanText(message.text_body);
  if (!input) return 'I can currently process text messages only. Please type a response.';
  let conversation = await getConversation(message.from_number);
  if (!conversation) { await createConversation(message); return `${INTRO}\n\n${renderPrompt('JUR_EMPLOYEE')}`; }
  const processed = Array.isArray(conversation.processed_message_ids) ? conversation.processed_message_ids : [];
  if (message.whatsapp_message_id && processed.includes(message.whatsapp_message_id)) return null;
  const command = normalize(input);
  if (['restart', 'start again', 'reset'].includes(command)) return restartConversation(conversation, message);
  if (['help', 'human', 'agent', 'attorney', 'lawyer'].includes(command)) return markHandoff(conversation, message, 'USER_REQUESTED_HELP', conversation.collected_facts || {});
  if (conversation.status === 'completed') return 'Your intake has already been submitted. Type RESTART for a new matter, or HELP for assistance.';
  if (conversation.status === 'handoff') return 'Your enquiry is already waiting for human review. Type RESTART only for a different matter.';

  const stepName = conversation.current_step || 'JUR_EMPLOYEE';
  const step = STEPS[stepName];
  if (!step) return restartConversation(conversation, message);
  let facts = { ...(conversation.collected_facts || {}) };

  if (step.type === 'classify') {
    const classification = await invokeAsk('classify', { text: input });
    facts = mergeNarrativeFacts({ ...facts, initial_query: input }, classification);
    if (!hasValue(facts.employment_status)) facts.employment_status = classification.category || 'Ambiguous';
    if (!hasValue(facts.dismissal_reason_type) && classification.dismissal_reason_type) facts.dismissal_reason_type = classification.dismissal_reason_type;
    if (!hasValue(facts.advisory_topic) && classification.advisory_topic) facts.advisory_topic = classification.advisory_topic;
    const next = resolveNextUnanswered(routeClassification(classification), facts);
    await updateConversation(conversation.id, { current_step: next, collected_facts: facts, classification,
      processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id), last_inbound_at: new Date().toISOString() });
    return renderPrompt(next);
  }
  if (step.type === 'evaluate') return completeEvaluation(conversation, message, facts);

  let next;
  if (step.type === 'buttons') {
    const selected = matchChoice(input, step);
    if (!selected) return `I did not understand that answer. Reply with the number or wording shown.\n\n${renderPrompt(stepName)}`;
    facts[step.saveAs] = selected.value;
    facts = markDirectAnswer(facts, step.saveAs);
    next = resolveNextUnanswered(selected.next, facts);
  } else {
    if (step.type === 'date' && !validDate(input)) return `Please enter the date as YYYY-MM-DD or DD/MM/YYYY.\n\n${step.prompt}`;
    if (step.minWords && wordCount(input) < step.minWords) return `Please add a little more detail, ideally at least ${step.minWords} words.\n\n${step.prompt}`;
    facts[step.saveAs] = input;
    facts = markDirectAnswer(facts, step.saveAs);
    next = resolveNextUnanswered(step.next, facts);
  }

  if (DEFLECTIONS[next]) return markHandoff(conversation, message, next, facts);
  if (next === 'HANDOFF') return completeEvaluation(conversation, message, facts);
  await updateConversation(conversation.id, { current_step: next, collected_facts: facts,
    processed_message_ids: appendMessageId(conversation, message.whatsapp_message_id), last_inbound_at: new Date().toISOString() });
  return renderPrompt(next);
}

module.exports = { processIncomingMessage, STEPS, renderPrompt };
