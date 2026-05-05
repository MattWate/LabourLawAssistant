const JURISDICTION_GATE_QUESTIONS = [
  {
    id: 'employee_status',
    text: 'Are you an employee, as opposed to an independent contractor?',
    legalBasis: 'LRA s200A; the dominant impression test',
    failOutcome: 'No merit. Output: jurisdictional triage explaining the dominant impression test, recommending civil contract advice.'
  },
  {
    id: 'south_african_employer',
    text: 'Is your employer a South African registered entity, or operating in South Africa?',
    legalBasis: 'LRA s4; jurisdictional reach',
    failOutcome: 'Flag for international or cross-border advice. Capture the lead in the admin dashboard.'
  },
  {
    id: 'public_service_or_excluded_agency',
    text: 'Are you employed in the public service under the Public Service Act, or by a government agency such as DOL, DPW, DOH, SAPS, or by the SANDF?',
    legalBasis: 'LRA s2(2) and s9; sector exclusions',
    failOutcome: 'Triage to the correct forum (PSCBC, GPSSBC, ELRC, SSSBC or military grievance procedures). Do not apply blanket reject. Capture the lead in the admin dashboard with the correct forum tagged.'
  },
  {
    id: 'schedule_2_soe_ccma_eligible',
    text: 'Are you a Schedule 2 SOE employee whose dispute remains CCMA-eligible?',
    legalBasis: 'LRA general application; case-by-case sectoral assessment',
    failOutcome: 'If yes, proceed to Phase 2 as normal. If unclear, flag for attorney review before proceeding.'
  }
];

const CONTRACTOR_CONTROL_SUBQUESTION = {
  id: 'contractor_control_test',
  text: 'Does someone tell you when to start work, when to stop work, and how to do the work?'
};

const PHASE_2_OPENING_QUESTION = {
  id: 'phase_2_opening_question',
  text: 'Hi there. I am Justine, a Labour Law Assistant. Briefly tell me about the work issue you need help with so I can guide you. There is no right or wrong way to describe it. In your own words, what has happened?'
};

function getJurisdictionGateQuestions() {
  return JURISDICTION_GATE_QUESTIONS;
}

module.exports = {
  JURISDICTION_GATE_QUESTIONS,
  CONTRACTOR_CONTROL_SUBQUESTION,
  PHASE_2_OPENING_QUESTION,
  getJurisdictionGateQuestions
};
