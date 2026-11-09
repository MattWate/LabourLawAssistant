const assert = require('assert');
const { buildCaseBrief } = require('../netlify/functions/lib/claudeDrafting');

const cases = [
  {
    id:'misconduct',
    facts:{
      client_name:'Test Client', employer_name:'Test Employer',
      incident_description:'Client was dismissed for alleged insubordination after a disciplinary hearing.',
      employment_status:'Dismissed', dismissal_reason_type:'Misconduct',
      hearing_held:true, proc_notice:false, proc_rep:false, proc_chair:false,
      prior_warnings:'None', length_of_service:'5 years',
      misconduct_category:'insubordination', conduct_admission:'Dispute',
      track:'UD-MISCONDUCT', substantive_score:7, procedural_score:9,
      merit_band:'HIGH', wp_type:'FULL',
      legal_basis:['Schedule 8'], scoring_breakdown:[], strengths:[], weaknesses:[]
    },
    material:['hearing_held','proc_notice','proc_rep','proc_chair','prior_warnings','length_of_service','misconduct_category','conduct_admission']
  },
  {
    id:'performance',
    facts:{
      client_name:'Test Client', employer_name:'Test Employer',
      incident_description:'Client was dismissed for poor performance.',
      employment_status:'Dismissed', dismissal_reason_type:'Poor Performance',
      performance_standards_communicated:true, pip_given:false, pip_duration:null,
      training_provided:false, performance_control:'External factors',
      team_meeting_standards:'No', prior_performance_warnings:'None',
      length_of_service:'2-5y', track:'UD-POOR_PERFORMANCE',
      substantive_score:8, procedural_score:8, merit_band:'HIGH', wp_type:'FULL',
      legal_basis:['Schedule 8'], scoring_breakdown:[], strengths:[], weaknesses:[]
    },
    material:['performance_standards_communicated','pip_given','pip_duration','training_provided','performance_control','team_meeting_standards','prior_performance_warnings','length_of_service']
  },
  {
    id:'retrenchment',
    facts:{
      client_name:'Test Client', employer_name:'Test Employer',
      incident_description:'Client was retrenched.',
      employment_status:'Dismissed', dismissal_reason_type:'Retrenchment',
      retrenchment_headcount:'Just me', s189_notice:false,
      retrenchment_consultation:'No consultation', selection_criteria_objective:false,
      retrenchment_alternatives:false, severance_pay:'Yes',
      operational_reason_plausible:'I doubt it', role_refilled:'No',
      protected_ground:'pregnancy', track:'UD-RETRENCHMENT', secondary_track:'AUD',
      substantive_score:9, procedural_score:10, merit_band:'HIGH', wp_type:'FULL',
      legal_basis:['LRA s189','LRA s187'], scoring_breakdown:[], strengths:[], weaknesses:[]
    },
    material:['retrenchment_headcount','s189_notice','retrenchment_consultation','selection_criteria_objective','retrenchment_alternatives','severance_pay','operational_reason_plausible','role_refilled','protected_ground']
  }
];

for (const test of cases) {
  const brief = buildCaseBrief({facts:test.facts,senderVariant:'VRS',clientSide:'employee'});
  const serialized = JSON.stringify(brief);
  const present = [];
  const missing = [];
  for (const key of test.material) {
    if (
      Object.prototype.hasOwnProperty.call(brief,key) ||
      Object.prototype.hasOwnProperty.call(brief.structured_case_facts || {},key)
    ) present.push(key);
    else if (test.facts[key] === null || test.facts[key] === undefined || test.facts[key] === '') {
      // Intentionally absent facts should not be invented or counted as lost.
    } else missing.push(key);
  }
  assert.strictEqual(missing.length, 0, `${test.id} lost material drafting facts: ${missing.join(', ')}`);
  console.log(JSON.stringify({
    case:test.id,
    material_fact_count:test.material.length,
    directly_present_count:present.length,
    directly_missing_count:missing.length,
    directly_present:present,
    directly_missing:missing,
    coverage_ratio:present.length/test.material.length,
    case_brief:brief
  }));
}

// Coverage harness rerun after joined-up reasoning fix.
