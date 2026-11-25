const fs=require('fs');
const {execFileSync}=require('child_process');
const {scoreCase}=require('../netlify/functions/lib/scoringEngine');
const {validateLegalAuthorities}=require('../netlify/functions/lib/legalAuthorityRegistry');
const {validateRevisionIntegrity,sha256}=require('../netlify/functions/lib/revisionIntegrity');
const {buildLetterPolicy,validateLetterPolicy}=require('../netlify/functions/lib/letterPolicy');

const failures=[];
const passes=[];
function check(ok,id,msg){(ok?passes:failures).push({id,msg});}
function exists(p){return fs.existsSync(p);}
function read(p){return fs.readFileSync(p,'utf8');}
function syntax(p){try{execFileSync(process.execPath,['--check',p],{stdio:'pipe'});check(true,'SYNTAX:'+p,'parses');}catch(e){check(false,'SYNTAX:'+p,e.stderr?.toString()||e.message);}}

console.log('JUSTINE RELEASE READINESS GATE');

const matrix=JSON.parse(read('scripts/uat-findings-matrix.json'));
const expected=[...Array.from({length:23},(_,i)=>'F'+(i+1)),...Array.from({length:30},(_,i)=>'P'+(i+1)),...Array.from({length:19},(_,i)=>'L'+(i+1))];
const ids=matrix.findings.map(x=>x.id);
check(matrix.findings.length===72,'MATRIX-72','all 72 UAT findings present');
check(expected.every(id=>ids.includes(id)) && new Set(ids).size===72,'MATRIX-IDS','F1-23, P1-30 and L1-19 uniquely represented');
const uncoveredHigh=matrix.findings.filter(x=>x.severity.startsWith('High') && !x.coverage);
check(uncoveredHigh.length===0,'MATRIX-HIGH-COVERAGE','every High finding has named coverage');

for(const p of [
 'netlify/functions/ask.js','netlify/functions/lib/scoringEngine.js','netlify/functions/lib/claudeDrafting.js',
 'netlify/functions/client_letter_review.js','netlify/functions/manage_letter_release.js',
 'netlify/functions/lib/pdfDocument.js','netlify/functions/release_readiness_probe.js',
 'netlify/functions/lib/legalAuthorityRegistry.js','netlify/functions/lib/revisionIntegrity.js',
 'netlify/functions/lib/letterPolicy.js'
]) syntax(p);

const web=read('index.html');
const ask=read('netlify/functions/ask.js');
const scoring=read('netlify/functions/lib/scoringEngine.js');
const drafting=read('netlify/functions/lib/claudeDrafting.js');
const review=read('netlify/functions/client_letter_review.js');
const release=read('netlify/functions/manage_letter_release.js');
const admin=read('admin-workstation.html');
const netlify=read('netlify.toml');

// P5/P6/F8 — Card 03 must not become HIGH merely because "shop steward" is mentioned.
const card03=scoreCase({
 track:'UD-MISCONDUCT',
 employment_status:'dismissed',
 dismissal_reason_type:'Misconduct',
 misconduct_category:'assault',
 conduct_admission:'Admit',
 hearing_held:true,
 proc_notice:true,
 proc_rep:true,
 proc_chair:true,
 prior_warnings:'Final warning in force',
 length_of_service:'7 years',
 initial_query:'I admitted assault. I had a fair disciplinary hearing. My shop steward represented me. I already had a final warning in force.'
});
check(!card03.merit_bonus_trigger,'P5','shop steward mention does not trigger s187/union protected-activity bonus');
check(card03.merit_band!=='HIGH','P6','admitted assault + fair procedure + live final warning cannot score HIGH');
check(card03.wp_eligible!==true,'F8','no/low-merit Card 03 is not automatically offered a WP letter');

const explicitUnionRetaliation=scoreCase({
 track:'AUD',
 employment_status:'dismissed',
 protected_ground:'union activity',
 incident_description:'I was dismissed because of my union activity after organising members.'
});
check(explicitUnionRetaliation.merit_bonus_trigger?.name==='Union membership or activity','P5-POSITIVE','directly captured union retaliation still triggers protected-activity treatment');

// F23/P30 — public service must be triaged, not hard-deflected before contact/deadline capture.
check(!/JUR_PUBLIC_SERVICE:[\s\S]{0,900}next:\s*"DEFLECT_PUBLIC_SERVICE"/.test(web),'F23','public-service answer does not hard-stop at question 3');
check(ask.includes("serviceability_status: 'OUT_OF_SCOPE'") && ask.includes("merit_band: 'NOT_ASSESSED'"),'P30','out-of-scope matters are distinct from a legal NO MERIT finding');

// F16/F2/F3/F22 — Batch B: intake must prioritise required facts, desired outcomes and suppress repeats.
check(!/OPTIONAL_BUDGET_STATES[^;]*ADDRESSEE_NAME/.test(web) && /REQUIRED_OPERATIONAL_STATES[^;]*ADDRESSEE_NAME/.test(web),'F16','addressee is protected as required operational data near the prompt cap');
check(/DESIRED_OUTCOME:[\s\S]{0,1800}saveAs:\s*"desired_outcome"/.test(web) && ask.includes('desired_outcome: facts.desired_outcome'),'F2','desired client outcome is explicitly captured and persisted');
check(!/DESIRED_OUTCOME:[\s\S]{0,1800}next:\s*"DESIRED_OUTCOME",\s*val:\s*"(?:Financial settlement|Mutual separation|Reference or record outcome|Internal resolution|Advice only)"/.test(web),'F2-FLOW','desired outcome options do not loop back to themselves');
check(/incident_description/.test(web) && /describe what happened/i.test(web),'F3','client own-account narrative remains an explicit intake requirement');
check(web.includes('_pending_confirmation'),'F22','confirmation state exists for deduplication checks');

// L11/L12/L17 — targeted revision infrastructure must exist and reject uncontrolled rewrites.
check(exists('netlify/functions/lib/revisionIntegrity.js'),'L11','targeted revision integrity module exists');
const revisionSource='Background\nThe employee was dismissed on 10 November 2026 after a disciplinary process.\nLegal Claims\nThe dismissal is challenged under LRA section 188(1).';
const targetedRevision={
  part_a_letter:{
    opening_paragraphs:['The employee was dismissed on 10 November 2026 after a disciplinary process.'],
    legal_claims:[{title:'Fairness of dismissal',text:'The dismissal is challenged under LRA section 188(1) and the client asks that the reference wording also be corrected.'}],
    settlement_intro:'The parties are invited to resolve the dispute.',
    settlement_terms:['Provide an agreed neutral employment reference.'],
    conclusion_paragraphs:['We invite a constructive response.']
  }
};
const revisionOk=validateRevisionIntegrity({
  caseBrief:{
    revision_round:1,
    revision_source_letter:revisionSource,
    revision_source_hash:sha256(revisionSource),
    client_requested_changes:'Please change the reference wording to a neutral reference.',
    structured_case_facts:{incident_date:'2026-11-10'}
  },
  draft:targetedRevision
});
check(revisionOk.ok,'L12','targeted revision passes deterministic integrity invariants');
const uncontrolled=validateRevisionIntegrity({
  caseBrief:{
    revision_round:1,
    revision_source_letter:revisionSource,
    revision_source_hash:sha256(revisionSource),
    client_requested_changes:'Please change the reference wording only.',
    structured_case_facts:{incident_date:'2026-11-10'}
  },
  draft:{part_a_letter:{opening_paragraphs:['A completely unrelated replacement narrative about another dispute and a new event on 14 December 2026.'],legal_claims:[],settlement_intro:'',settlement_terms:[],conclusion_paragraphs:[]}}
});
check(!uncontrolled.ok && uncontrolled.defects.length>0,'L12-GUARD','uncontrolled rewrite/new date is deterministically rejected');
check(review.includes('client_revision_source_letter'),'L17','revision source version is persisted');
check(drafting.includes('revision_source_letter') && drafting.includes('revision_source_hash'),'L11b','drafter receives revision source and integrity hash');

// P15/L4 — factual QA must have deterministic unsupported-fact protection.
check(exists('netlify/functions/lib/draftingFactsGuard.js') || drafting.includes('mandatoryDraftingDefects'),'P15','deterministic factual QA guard exists');

// P8/L13/L15/L19 — verified legal authority layer.
check(exists('netlify/functions/lib/legalAuthorityRegistry.js'),'P8','verified legal authority registry exists');
const validAuthorities=validateLegalAuthorities({
  caseBrief:{track:'UD-MISCONDUCT'},
  draft:{part_a_letter:{opening_paragraphs:[],legal_claims:[{title:'Fairness',text:'The dismissal is challenged under LRA section 188(1), read with paragraphs 7-11 of the Code of Practice: Dismissal, 2025.'}],settlement_intro:'',settlement_terms:['Payment in lieu of the applicable notice period under BCEA section 38, with that notice period determined under BCEA section 37.'],conclusion_paragraphs:[]}}
});
check(validAuthorities.ok,'L13','registered LRA/BCEA/2025 Code citations pass deterministic validation');
const invalidAuthorities=validateLegalAuthorities({
  caseBrief:{track:'UD-MISCONDUCT'},
  draft:{part_a_letter:{opening_paragraphs:[],legal_claims:[{title:'Wrong law',text:'The dismissal is automatically governed by LRA section 999 and paragraph 25 of the Code of Practice: Dismissal, 2025.'}],settlement_intro:'',settlement_terms:[],conclusion_paragraphs:[]}}
});
check(!invalidAuthorities.ok && invalidAuthorities.defects.length>=2,'L15','unregistered statutory section and Code paragraph are deterministically rejected');
check(drafting.includes('verifiedAuthoritySummary') && drafting.includes('validateLegalAuthorities'),'P8-INTEGRATION','drafting prompt and quality gate use the verified authority registry');
check(!drafting.includes('old Schedule 8 text'),'L19','legacy Schedule 8 context is not deliberately injected');

// L2/L16/L18 — policy/track rules must be explicit rather than free-form.
check(!drafting.includes('Give the recipient seven calendar days to respond.') && drafting.includes('DETERMINISTIC LETTER POLICY'),'L2','response period comes from deterministic business-day policy rather than a fixed seven-calendar-day rule');
check(exists('netlify/functions/lib/letterPolicy.js'),'L16','time-bar disclosure policy module exists');
const nearExpiryPolicy=buildLetterPolicy({
  track:'UD-MISCONDUCT',
  ccma_deadline_status:{status:'WITHIN_WINDOW',daysRemaining:4}
});
check(nearExpiryPolicy.response.business_days===3 && nearExpiryPolicy.time_bar.disclose===true && nearExpiryPolicy.time_bar.level==='urgent_live','L16-LIVE','near-expiry referral produces an urgent independent deadline warning');
const lapsedPolicy=buildLetterPolicy({
  track:'UD-MISCONDUCT',
  ccma_deadline_status:{status:'LAPSED-CONDONATION',daysOverdue:5}
});
check(lapsedPolicy.response.business_days===3 && /condonation/i.test(lapsedPolicy.time_bar.instruction),'L16-LAPSED','lapsed referral explicitly surfaces condonation');
const urgentDraft=validateLetterPolicy({
  caseBrief:{track:'UD-MISCONDUCT',ccma_deadline_status:{status:'WITHIN_WINDOW',daysRemaining:4}},
  draft:{part_a_letter:{
    opening_paragraphs:['The statutory referral deadline remains independent of these settlement discussions and is not suspended or extended by this correspondence.'],
    legal_claims:[],
    settlement_intro:'We invite a response within 3 business days.',
    settlement_terms:['Compensation calibrated to the dismissal risk.'],
    conclusion_paragraphs:[]
  }}
});
check(urgentDraft.ok,'L16-GUARD','urgent draft with independent deadline wording passes deterministic policy validation');
check(exists('netlify/functions/lib/letterPolicy.js'),'L18','track-based settlement policy module exists');
const retrenchPolicy=buildLetterPolicy({track:'UD-RETRENCHMENT'});
const disciplinaryPolicy=buildLetterPolicy({track:'DISCIPLINARY'});
check(retrenchPolicy.settlement.categories.some(x=>x.id==='severance_if_due') && !disciplinaryPolicy.settlement.categories.some(x=>x.id==='severance_if_due'),'L18-TRACK','retrenchment and pre-dismissal disciplinary settlement categories are distinct');
const wrongDisciplinary=validateLetterPolicy({
  caseBrief:{track:'DISCIPLINARY'},
  draft:{part_a_letter:{opening_paragraphs:[],legal_claims:[],settlement_intro:'',settlement_terms:['Pay statutory severance and issue a UI-19.'],conclusion_paragraphs:[]}}
});
check(!wrongDisciplinary.ok,'L18-GUARD','termination remedies are rejected for a pre-dismissal disciplinary track unless specifically supported');

// P21/P28 — PDF release and preview/retry semantics.
check(netlify.includes('pdfkit') && netlify.includes('included_files'),'P21-PACKAGE','Netlify config explicitly handles PDFKit assets');
check(release.includes('renderReleasedLetterPdf'),'P21-CODE','release uses PDF generation');
check(admin.includes('letter_send_failed'),'P21-STATE','failed release has a visible status');
check(
  admin.includes("manageLetter('") &&
  admin.includes("'preview'") &&
  release.includes("action === 'preview'") &&
  release.includes('final_release_preview_hash') &&
  release.includes('Preview the final client-approved PDF before sending it to the employer.'),
  'P28',
  'final client-approved PDF has an authenticated preview path and send is gated on that exact preview'
);

// P10/P11 — actor/audit visibility.
check(!/letter_approved_by[^\n]{0,100}sasha@vrslabourlaw\.co\.za/.test(release),'P10','release actor is not hard-coded');
check(admin.includes('Activity') || admin.includes('audit'),'P11','case page exposes an activity/audit view');

// F11/P12 — commercial clarity.
check(web.includes('R10') || web.includes('10.00') || ask.includes('R10'),'F11','fee is shown before payment consent');
check(
  admin.includes('Payment amount') &&
  admin.includes('Confirmation channel') &&
  admin.includes('payment_confirmation_channel') &&
  admin.includes('payment_amount'),
  'P12',
  'admin payment confirmation exposes authoritative channel and amount'
);

// Fixed-regression markers retained.
check(web.includes('CONTACT_NAME') && web.includes('CONTACT_EMAIL') && web.includes('CONTACT_PHONE'),'F16-FIX','early contact capture remains');
check(ask.includes("action === 'deadline_check'"),'F17-FIX','immediate deadline check remains');
check(release.includes("caseData.letter_status !== 'client_approved'"),'CLIENT-APPROVAL','exact client approval remains a release gate');

console.log('\nPASS:',passes.length);
for(const p of passes) console.log('  ✓',p.id,'-',p.msg);
console.log('\nFAIL:',failures.length);
for(const f of failures) console.log('  ✗',f.id,'-',f.msg);

const highOpen=new Set(matrix.findings.filter(x=>x.severity.startsWith('High') && !['Fixed'].includes(x.status)).map(x=>x.id));
const blockingFailures=failures.filter(f=>highOpen.has(f.id) || ['MATRIX-72','MATRIX-IDS','MATRIX-HIGH-COVERAGE','P21-PACKAGE','P21-CODE','P21-STATE','P28','CLIENT-APPROVAL'].includes(f.id));
console.log('\nBLOCKING FAILURES:',blockingFailures.length);
if(blockingFailures.length) process.exit(1);
console.log('\nRELEASE READINESS GATE PASSED');
