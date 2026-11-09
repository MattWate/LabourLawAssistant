
const { createClient } = require('@supabase/supabase-js');
const { loadWpSkillSet, buildProtectedPromptContext } = require('../netlify/functions/lib/skillRegistry');
const { buildCaseBrief, callClaudeForWpDraft } = require('../netlify/functions/lib/claudeDrafting');
const { normaliseLetterStructure, letterStructureToPlainText } = require('../netlify/functions/lib/letterStructure');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.ANTHROPIC_API_KEY) {
  throw new Error('Required test secrets are missing');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const cases = [
  {
    id: 'misconduct-procedural',
    facts: {
      client_name: 'Thabo Mokoena',
      employer_name: 'Northstar Logistics (Pty) Ltd',
      employer_contact_details: 'HR Manager',
      incident_date: '2026-10-21',
      incident_description: 'Thabo worked for the employer for six years. He was accused of insubordination after refusing to drive a delivery vehicle that he said had faulty brakes. He asked for the instruction to be put in writing. He was told at 08:00 that a disciplinary hearing would take place at 10:00 the same day. He was not allowed to bring a colleague. His direct manager, who had issued the instruction, chaired the hearing. Thabo denied being insubordinate and said he was concerned about safety. He was dismissed immediately after the hearing.',
      original_client_narrative: 'I refused to drive the truck because the brakes were faulty. My manager said I was insubordinate and then chaired my hearing two hours later. I was not allowed anyone with me and I was fired the same day.',
      employment_status: 'Dismissed',
      dismissal_reason_type: 'Misconduct',
      misconduct_category: 'insubordination',
      conduct_admission: 'Dispute',
      hearing_held: true,
      proc_notice: false,
      proc_rep: false,
      proc_chair: false,
      prior_warnings: 'None',
      length_of_service: '5 years',
      track: 'UD-MISCONDUCT',
      track_label: 'Unfair Dismissal — Misconduct',
      substantive_score: 7,
      procedural_score: 9,
      merit_band: 'HIGH',
      wp_type: 'FULL',
      legal_basis: ['LRA Schedule 8 Code of Good Practice: Dismissal', 'Occupational Health and Safety Act context'],
      scoring_breakdown: [
        { points: 3, label: 'Short notice before hearing', legalHook: 'procedural fairness' },
        { points: 3, label: 'Representation denied', legalHook: 'procedural fairness' },
        { points: 3, label: 'Chairperson directly involved', legalHook: 'procedural fairness' },
        { points: 2, label: 'Safety-related context to alleged insubordination', legalHook: 'substantive fairness' }
      ],
      recommended_next_step: 'Without Prejudice settlement letter addressing procedural unfairness and the safety context.',
      ccma_deadline_status: { status: 'WITHIN_WINDOW', daysRemaining: 11 },
      strengths: ['Short notice', 'Representation denied', 'Biased chair', 'Safety context'],
      weaknesses: ['Employer may argue refusal of instruction was misconduct']
    }
  },
  {
    id: 'poor-performance',
    facts: {
      client_name: 'Lerato Ndlovu',
      employer_name: 'Brightline Retail SA (Pty) Ltd',
      employer_contact_details: 'People & Culture Manager',
      incident_date: '2026-10-28',
      incident_description: 'Lerato was a regional sales coordinator employed for three years. In August she was told that her sales figures were below target. She says the targets had been increased by 35% while two vacancies in her team remained unfilled. She was never placed on a formal performance improvement plan. She had two coaching meetings over three weeks but no written improvement plan, no agreed milestones and no additional resources. She was dismissed for poor performance after the second coaching meeting.',
      original_client_narrative: 'My targets went up 35 percent while we were two people short. They called two meetings coaching but I never got a PIP or clear plan. Three weeks later they fired me for poor performance.',
      employment_status: 'Dismissed',
      dismissal_reason_type: 'Poor Performance',
      performance_standards_communicated: true,
      pip_given: false,
      training_provided: false,
      performance_control: 'External factors',
      team_meeting_standards: 'No',
      prior_performance_warnings: 'None',
      length_of_service: '2-5y',
      track: 'UD-POOR_PERFORMANCE',
      track_label: 'Unfair Dismissal — Poor Performance',
      substantive_score: 8,
      procedural_score: 8,
      merit_band: 'HIGH',
      wp_type: 'FULL',
      legal_basis: ['LRA Schedule 8 Code of Good Practice: Dismissal'],
      scoring_breakdown: [
        { points: 3, label: 'No proper opportunity to improve', legalHook: 'poor performance fairness' },
        { points: 2, label: 'Targets affected by understaffing', legalHook: 'reasonableness' },
        { points: 2, label: 'No formal PIP or milestones', legalHook: 'procedural fairness' }
      ],
      recommended_next_step: 'WP letter challenging the adequacy of the performance-management process and the fairness of dismissal.',
      ccma_deadline_status: { status: 'WITHIN_WINDOW', daysRemaining: 18 },
      strengths: ['No proper PIP', 'Understaffing affected targets', 'Very short improvement period'],
      weaknesses: ['Employer had raised performance concerns before dismissal']
    }
  },
  {
    id: 'retrenchment-pregnancy',
    facts: {
      client_name: 'Naledi Dlamini',
      employer_name: 'Orbit Creative Agency (Pty) Ltd',
      employer_contact_details: 'Managing Director',
      incident_date: '2026-10-30',
      incident_description: 'Naledi had worked for the agency for three years. She told her manager that she was pregnant and two weeks later was informed that her role was redundant. She says the business had recently won two new clients, that another junior employee in the same team was retained, and that she received no written section 189(3) notice or meaningful consultation before the decision. She was offered one month notice and severance. The employer described the decision as restructuring.',
      original_client_narrative: 'I told my manager I was pregnant and two weeks later they retrenched me. We had just won two new clients. The junior in my team stayed and nobody consulted with me before telling me my job was gone.',
      employment_status: 'Dismissed',
      dismissal_reason_type: 'Retrenchment',
      retrenchment_headcount: 'Just me',
      s189_notice: false,
      retrenchment_consultation: 'No consultation',
      selection_criteria_objective: false,
      retrenchment_alternatives: false,
      severance_pay: 'Yes',
      operational_reason_plausible: 'I doubt it',
      role_refilled: 'No',
      protected_ground: 'pregnancy',
      override_flags: ['PREGNANCY', 'SHAM_RETRENCHMENT', 'PROTECTED_GROUND_DISCRIMINATION'],
      track: 'UD-RETRENCHMENT',
      secondary_track: 'AUD',
      track_label: 'Unfair Dismissal — Retrenchment',
      substantive_score: 9,
      procedural_score: 10,
      merit_band: 'HIGH',
      wp_type: 'FULL',
      legal_basis: ['LRA s189', 'LRA s187(1)(e)', 'Employment Equity Act pregnancy protection'],
      scoring_breakdown: [
        { points: 3, label: 'No section 189(3) notice', legalHook: 'LRA s189' },
        { points: 3, label: 'No meaningful consultation', legalHook: 'LRA s189' },
        { points: 3, label: 'Pregnancy disclosed shortly before dismissal', legalHook: 'LRA s187' },
        { points: 2, label: 'Selection rationale appears questionable', legalHook: 'substantive fairness' }
      ],
      recommended_next_step: 'Urgent WP letter challenging the retrenchment process and raising the pregnancy-linked dismissal risk.',
      ccma_deadline_status: { status: 'WITHIN_WINDOW', daysRemaining: 20 },
      strengths: ['Timing after pregnancy disclosure', 'No consultation', 'No section 189 notice', 'Questionable selection'],
      weaknesses: ['Employer may produce financial or restructuring evidence not yet seen']
    }
  },
  {
    id: 'constructive-dismissal',
    facts: {
      client_name: 'Michael Jacobs',
      employer_name: 'Apex Technical Services (Pty) Ltd',
      employer_contact_details: 'HR Director',
      incident_date: '2026-10-25',
      incident_description: 'Michael resigned after four months in which his salary was repeatedly paid late and twice only partially paid. He lodged two written grievances about non-payment. After the second grievance his manager removed his access to key systems and told colleagues that Michael was disloyal. HR acknowledged the salary arrears but did not provide a payment plan. Michael resigned stating that the ongoing non-payment and treatment had made continued employment intolerable.',
      original_client_narrative: 'They kept paying me late and twice only part of my salary. I complained in writing twice. After that my manager took away my system access and told people I was disloyal. HR admitted they owed me but never fixed it. I resigned because I could not carry on.',
      employment_status: 'Resigned',
      intolerable_conduct: 'salary reduction or non-payment',
      grievance_raised: true,
      override_flags: ['SUSTAINED_NON_PAYMENT'],
      track: 'CD',
      track_label: 'Constructive Dismissal',
      substantive_score: 9,
      procedural_score: 8,
      merit_band: 'HIGH',
      wp_type: 'FULL',
      legal_basis: ['LRA s186(1)(e)', 'BCEA wage-payment obligations'],
      scoring_breakdown: [
        { points: 3, label: 'Repeated non-payment/late payment', legalHook: 'intolerability' },
        { points: 2, label: 'Written grievances before resignation', legalHook: 'employee attempted resolution' },
        { points: 2, label: 'Adverse treatment after grievance', legalHook: 'causal context' }
      ],
      recommended_next_step: 'WP letter setting out constructive-dismissal basis and seeking settlement before referral.',
      ccma_deadline_status: { status: 'WITHIN_WINDOW', daysRemaining: 15 },
      strengths: ['Repeated salary breaches', 'Prior grievances', 'Adverse treatment after complaints'],
      weaknesses: ['Employer may dispute that resignation was the last reasonable option']
    }
  }
];

async function main() {
  const skillSet = await loadWpSkillSet(supabase, { side: 'employee' });
  const skillContext = buildProtectedPromptContext(skillSet);
  console.log('HARNESS_SKILL_HASH', skillSet.skill_hash);

  for (const testCase of cases) {
    const caseBrief = buildCaseBrief({ facts: testCase.facts, senderVariant: 'VRS', clientSide: 'employee' });
    const result = await callClaudeForWpDraft({ skillContext, caseBrief, skillSet });
    const structure = normaliseLetterStructure(result.draft.part_a_letter || {});
    const letter = letterStructureToPlainText(structure);
    const assessment = result.draft.part_b_supervisory_assessment || {};

    console.log('\n===== CASE_START ' + testCase.id + ' =====');
    console.log('CASE_BRIEF_JSON', JSON.stringify(caseBrief));
    console.log('SUPERVISOR_JSON', JSON.stringify(assessment));
    console.log('LETTER_START');
    console.log(letter);
    console.log('LETTER_END');
    console.log('===== CASE_END ' + testCase.id + ' =====\n');
  }
}
main().catch(err => { console.error(err.stack || err); process.exit(1); });
