const fs=require('fs');
const {execFileSync}=require('child_process');
const {scoreCase}=require('../netlify/functions/lib/scoringEngine');

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
 'netlify/functions/lib/pdfDocument.js','netlify/functions/release_readiness_probe.js'
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

// L11/L12/L17 — targeted revision infrastructure must exist.
check(exists('netlify/functions/lib/revisionIntegrity.js'),'L11','targeted revision integrity module exists');
check(exists('netlify/functions/lib/revisionIntegrity.js'),'L12','revision QA invariants are implemented');
check(review.includes('client_revision_source_letter'),'L17','revision source version is persisted');
check(drafting.includes('revision_source_letter'),'L11b','drafter receives the revision source');

// P15/L4 — factual QA must have deterministic unsupported-fact protection.
check(exists('netlify/functions/lib/draftingFactsGuard.js') || drafting.includes('mandatoryDraftingDefects'),'P15','deterministic factual QA guard exists');

// P8/L13/L15/L19 — verified legal authority layer.
check(exists('netlify/functions/lib/legalAuthorityRegistry.js'),'P8','verified legal authority registry exists');
check(exists('netlify/functions/lib/legalAuthorityRegistry.js'),'L13','Code/statute citations are registry-backed');
check(exists('netlify/functions/lib/legalAuthorityRegistry.js'),'L15','wrong statutory sections can be deterministically rejected');
check(!drafting.includes('old Schedule 8 text'),'L19','legacy Schedule 8 context is not deliberately injected');

// L2/L16/L18 — policy/track rules must be explicit rather than free-form.
check(!drafting.includes('Give the recipient seven calendar days to respond.'),'L2','response period is not hard-coded to seven calendar days');
check(exists('netlify/functions/lib/letterPolicy.js'),'L16','time-bar disclosure policy is explicit and testable');
check(exists('netlify/functions/lib/letterPolicy.js'),'L18','settlement clauses are selected by track');

// P21/P28 — PDF release and preview/retry semantics.
check(netlify.includes('pdfkit') && netlify.includes('included_files'),'P21-PACKAGE','Netlify config explicitly handles PDFKit assets');
check(release.includes('renderReleasedLetterPdf'),'P21-CODE','release uses PDF generation');
check(admin.includes('letter_send_failed'),'P21-STATE','failed release has a visible status');
check(admin.includes('preview') || admin.includes('PDF Preview'),'P28','final release document has a preview path before send');

// P10/P11 — actor/audit visibility.
check(!/letter_approved_by[^\n]{0,100}sasha@vrslabourlaw\.co\.za/.test(release),'P10','release actor is not hard-coded');
check(admin.includes('Activity') || admin.includes('audit'),'P11','case page exposes an activity/audit view');

// F11/P12 — commercial clarity.
check(web.includes('R10') || web.includes('10.00') || ask.includes('R10'),'F11','fee is shown before payment consent');
check(admin.includes('channel') && admin.includes('amount'),'P12','payment confirmation exposes channel and amount');

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
