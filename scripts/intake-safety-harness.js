const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  deadlineStatus,
  deadlineMessage,
  promptBudgetDecision,
  candidateDateFromGovernance
} = require('../netlify/functions/lib/intakeSafety');
const { ccmaStatus } = require('../netlify/functions/lib/scoringEngine');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function checkIncludes(text, markers, label) {
  for (const marker of markers) assert(text.includes(marker), label + ' missing marker: ' + marker);
}
function syntax(path) {
  execFileSync(process.execPath, ['--check', path], { stdio:'inherit' });
}

console.log('Justine intake safety harness');

for (const path of [
  'netlify/functions/ask.js',
  'netlify/functions/lib/intakeSafety.js',
  'netlify/functions/lib/scoringEngine.js',
  'netlify/functions/lib/llmGovernance.js',
  'netlify/functions/lib/whatsappConversation.js',
  'netlify/functions/lib/whatsappProductionConversation.js',
  'netlify/functions/approve_case_for_payment.js',
  'netlify/functions/client_case_consent.js',
  'netlify/functions/uat_log_review.js'
]) syntax(path);

// Replay UAT card 04: dismissal on 13 Oct, reviewed 16 Nov => ordinary 30-day period lapsed.
const card04 = deadlineStatus({
  track:'UD-POOR_PERFORMANCE',
  employment_status:'dismissed',
  incident_date:'2026-10-13'
}, new Date('2026-11-16T12:00:00Z'));
assert(card04.status === 'LAPSED-CONDONATION', 'Card 04 must be identified as lapsed');
assert(card04.daysElapsed === 34, 'Card 04 expected 34 elapsed days');
assert(card04.daysOverdue === 4, 'Card 04 expected 4 days overdue');
assert(/condonation/i.test(deadlineMessage(card04) || ''), 'Card 04 must surface condonation warning');
console.log('PASS card 04 deadline replay', card04);

const card04Inferred = ccmaStatus({
  employment_status:'dismissed',
  dismissal_reason_type:'Poor Performance',
  incident_date:'2026-10-13'
});
assert(['LAPSED-CONDONATION','WITHIN_WINDOW'].includes(card04Inferred.status), 'Scoring deadline must infer dismissal track when track is absent');
console.log('PASS deadline track inference without explicit track', card04Inferred);

// Replay UAT card 07: source says only "19 October". AI date must remain candidate-only.
const card07Candidate = candidateDateFromGovernance({
  value:'2024-10-19',
  narrative:"I resigned on 19 October because my employer hasn't paid my salary for August and September.",
  confidence:0.85
});
assert(card07Candidate.explicit_year_in_source === false, 'Card 07 source must be recognised as missing a year');
assert(card07Candidate.confirmed === false, 'Card 07 AI date must never be confirmed');
assert(card07Candidate.usable_as_legal_date === false, 'Card 07 AI date must never be usable as a legal date');
console.log('PASS card 07 missing-year replay', card07Candidate);

// Explicit-year candidate is still not a legal fact until direct client confirmation.
const explicitCandidate = candidateDateFromGovernance({
  value:'2026-10-19',
  narrative:'I resigned on 19 October 2026.',
  confidence:0.99
});
assert(explicitCandidate.explicit_year_in_source === true, 'Explicit year should be recognised');
assert(explicitCandidate.confirmed === false && explicitCandidate.usable_as_legal_date === false, 'Even explicit AI date stays candidate-only');
console.log('PASS explicit-year candidate remains unconfirmed');

// Prompt budget: contacts, legal dates and required operational release data survive; normal substantive questions stop at the cap.
assert(promptBudgetDecision({state:'CONTACT_EMAIL',count:15,limit:15}).allow === true, 'Contact capture must survive prompt cap');
assert(promptBudgetDecision({state:'FIRED_DATE',count:15,limit:15}).allow === true, 'Legal date must survive prompt cap');
assert(promptBudgetDecision({state:'ADDRESSEE_POSITION',count:15,limit:15}).allow === true, 'Required addressee detail must survive prompt cap');
assert(promptBudgetDecision({state:'P5_TRAINING',count:15,limit:15}).allow === false, 'Normal substantive question must stop at cap');
console.log('PASS priority-based prompt budget');

const web = fs.readFileSync('index.html','utf8');
const ask = fs.readFileSync('netlify/functions/ask.js','utf8');
const wa = fs.readFileSync('netlify/functions/lib/whatsappConversation.js','utf8');
const waProd = fs.readFileSync('netlify/functions/lib/whatsappProductionConversation.js','utf8');
const governance = fs.readFileSync('netlify/functions/lib/llmGovernance.js','utf8');
const approve = fs.readFileSync('netlify/functions/approve_case_for_payment.js','utf8');
const consent = fs.readFileSync('netlify/functions/client_case_consent.js','utf8');
const review = fs.readFileSync('netlify/functions/uat_log_review.js','utf8');
const scoring = fs.readFileSync('netlify/functions/lib/scoringEngine.js','utf8');

checkIncludes(web, [
  'CONTACT_NAME:',
  'CONTACT_EMAIL:',
  'CONTACT_PHONE:',
  'collectedFacts._post_contact_state',
  'currentState = "CONTACT_NAME"',
  'action: "intake_checkpoint"',
  'action: "deadline_check"',
  'deadline_calculated',
  'prompt_cap_reached',
  '_candidate_legal_date',
  'evaluation_started',
  'COMPANY_CONTACT: { msg: "Could you share a contact email or number for the employer\'s HR department or the addressee? Type UNKNOWN if you do not have it.", type: "text", next: "HANDOFF"'
], 'web intake');

assert(!web.includes('action: "intake_handoff", reason, missing'), 'Web prompt cap must not use old hard handoff');
assert(!/collectedFacts\[key\]\s*=\s*value;[\s\S]{0,180}date_requires_client_confirmation/.test(web), 'Web AI date must not be promoted to legal fact');

checkIncludes(ask, [
  "if (action === 'deadline_check')",
  "if (action === 'intake_checkpoint')",
  '_intake_checkpoint_token_hash',
  '_intake_events',
  'Invalid intake checkpoint during evaluation',
  "_intake_checkpoint: false"
], 'ask backend');

checkIncludes(governance, [
  'Never infer or guess a year',
  'incident_date must be null/omitted'
], 'governance');

checkIncludes(wa, [
  "const WHATSAPP_PROMPT_LIMIT = 15",
  '_candidate_legal_date',
  '_post_contact_state',
  "let next = hasValue(facts.client_name) ? 'CLIENT_EMAIL' : 'CLIENT_NAME'",
  "invokeAsk('deadline_check'",
  'prompt_cap_reached',
  'return completeEvaluation(conversation, message, facts)',
  'appendIntakeEvent'
], 'WhatsApp intake');

assert(!wa.includes("return markHandoff(conversation, message, 'PROMPT_LIMIT_INCOMPLETE', facts);"), 'WhatsApp prompt cap must not hard handoff');
checkIncludes(waProd, [
  'hasPostContactRoute',
  'baseConversation.processIncomingMessage(message)'
], 'WhatsApp production wrapper');

checkIncludes(scoring, [
  'track: facts.track || inferTrack(facts)'
], 'scoring deadline inference');

for (const state of ['DESIRED_OUTCOME','COMPANY_NAME','ADDRESSEE_NAME','ADDRESSEE_POSITION','COMPANY_CONTACT']) {
  const decision = promptBudgetDecision({ state, count: 15, limit: 15 });
  assert(decision.allow === true && decision.countAgainstBudget === false, `Required operational state ${state} must survive the prompt cap`);
}
console.log('PASS required operational fields survive prompt cap');

checkIncludes(ask, [
  '...(data.case_facts || caseFacts)',
  '_intake_events: prior._intake_events || []'
], 'audit preservation');

checkIncludes(approve, [
  'sendEmailConsentRequest',
  "stage: 'mandate'",
  "stage: 'payment'",
  'client-consent.html?token=',
  "channel: 'email'"
], 'email consent fallback');

checkIncludes(consent, [
  "client_consent_stage === 'mandate'",
  "mandateAcceptanceSnapshot('email')",
  "paymentConsentSnapshot('email')",
  'client_consent_completed_at'
], 'client email consent endpoint');

checkIncludes(review, [
  'candidate_legal_date',
  'intake_events'
], 'UAT audit review');

// Browser inline JS syntax check.
const scripts = [...web.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim());
const appScript = scripts[scripts.length - 1];
assert(appScript && appScript.includes('const scriptFlow'), 'Could not locate web application script');
new Function(appScript);
console.log('PASS web inline JavaScript parses');

console.log('\nALL INTAKE SAFETY CHECKS PASSED');
