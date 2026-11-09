const assert=require('assert');
const fs=require('fs');
const { scoreCase }=require('../netlify/functions/lib/scoringEngine');

const misconduct=scoreCase({
  employment_status:'Dismissed',
  dismissal_reason_type:'Misconduct',
  conduct_admission:'Dispute',
  prior_warnings:'None',
  hearing_held:true,
  proc_notice:false,
  proc_rep:false,
  proc_chair:false,
  length_of_service:'5 years',
  incident_date:'2026-10-21',
  incident_description:'Dismissed for alleged insubordination.'
});
assert(misconduct.legal_basis.some(x=>x.includes('2025 Code of Practice: Dismissal')));
assert(!JSON.stringify(misconduct).includes('Schedule 8'));
assert(misconduct.scoring_breakdown.some(x=>String(x.legalHook).includes('para 11')));

const performance=scoreCase({
  employment_status:'Dismissed',
  dismissal_reason_type:'Poor Performance',
  performance_standards_communicated:false,
  pip_given:false,
  training_provided:false,
  performance_control:'External factors',
  incident_date:'2026-10-28',
  incident_description:'Dismissed for poor performance without proper improvement process.'
});
assert(performance.legal_basis.some(x=>x.includes('paras 19-20')));
assert(!JSON.stringify(performance).includes('Schedule 8'));

const incapacity=scoreCase({
  employment_status:'Dismissed',
  dismissal_reason_type:'Incapacity',
  proc_consultation:false,
  medical_review:false,
  alternatives_explored:false,
  incident_date:'2026-10-28',
  incident_description:'Dismissed while temporarily incapacitated.'
});
assert(incapacity.legal_basis.some(x=>x.includes('para 21')));
assert(!JSON.stringify(incapacity).includes('Schedule 8'));

const drafting=fs.readFileSync('netlify/functions/lib/claudeDrafting.js','utf8');
for(const s of [
  'CURRENT LAW OVERRIDE',
  'repealed the former Schedule 8',
  'BCEA section 38 deals with payment instead of notice',
  'do not silently choose one version',
  'Do not state or imply that VRS holds a "written mandate"',
  'avoid self-evaluative phrases'
]) assert(drafting.toLowerCase().includes(s.toLowerCase()), 'missing guardrail: '+s);

const fixture=fs.readFileSync('netlify/functions/lib/liveDraftingFixtures.js','utf8');
assert(fixture.includes('five years'));
assert(!fixture.includes('Thabo worked for the employer for six years'));
assert(fixture.includes('2025 Code of Practice: Dismissal paras 7-11'));

console.log('PASS current-law drafting regression checks');
