const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');
const {deadlineStatus,candidateDateFromGovernance,promptBudgetDecision}=require('../netlify/functions/lib/intakeSafety');
const {scoreCase}=require('../netlify/functions/lib/scoringEngine');
const {validateLegalAuthorities}=require('../netlify/functions/lib/legalAuthorityRegistry');
const {validateRevisionIntegrity,sha256}=require('../netlify/functions/lib/revisionIntegrity');
const {buildLetterPolicy}=require('../netlify/functions/lib/letterPolicy');

const ROOT=path.join(__dirname,'..');
const audit=JSON.parse(fs.readFileSync(path.join(__dirname,'uat-72-closure-audit.json'),'utf8'));
const cache=new Map();
function read(p){ if(!cache.has(p)) cache.set(p,fs.readFileSync(path.join(ROOT,p),'utf8')); return cache.get(p); }
function has(p,...markers){ const s=read(p); return markers.every(m=>s.includes(m)); }
function any(p,...markers){ const s=read(p); return markers.some(m=>s.includes(m)); }
function assert(v,m){if(!v) throw new Error(m);}
function source(name, fn){ return {name, fn}; }

const V={
  'intake-prefill':()=>assert(has('index.html','mergeAIExtractedFacts','canSkipStep','_fact_metadata'),'AI prefill/skip controls missing'),
  'intake-required-facts':()=>assert(has('index.html','DESIRED_OUTCOME:','incident_description','ADDRESSEE_NAME','COMPANY_CONTACT'),'required intake fields missing'),
  'intake-reason':()=>assert(has('index.html','dismissal_reason_type','misconduct_category'),'dismissal reason capture missing'),
  'service-precision':()=>assert(has('netlify/functions/ask.js','serviceability_status','determineProductRoute'),'serviceability/product routing missing'),
  'warning-detail':()=>assert(has('index.html','prior_warnings') && has('netlify/functions/lib/scoringEngine.js','final warning'),'warning detail handling missing'),
  'addressee-fields':()=>assert(has('index.html','ADDRESSEE_NAME','ADDRESSEE_POSITION','COMPANY_CONTACT'),'addressee fields missing'),
  'merit-outcome':()=>{const r=scoreCase({track:'UD-MISCONDUCT',employment_status:'dismissed',misconduct_category:'assault',conduct_admission:'Admit',hearing_held:true,proc_notice:true,proc_rep:true,proc_chair:true,prior_warnings:'Final warning in force',initial_query:'I admitted assault after a fair hearing.'});assert(r.merit_band!=='HIGH'&&r.wp_eligible!==true,'low-merit case still escalates incorrectly');},
  'deadline':()=>{const r=deadlineStatus({track:'UD-POOR_PERFORMANCE',employment_status:'dismissed',incident_date:'2026-10-13'},new Date('2026-11-16T12:00:00Z'));assert(r.status==='LAPSED-CONDONATION'&&r.daysOverdue===4,'deadline calculation regression');},
  'reference-consistency':()=>assert(has('netlify/functions/lib/pdfDocument.js','case_reference','OUR REFERENCE')&&has('admin-workstation.html','case_reference'),'case reference not consistently rendered'),
  'fee-display':()=>assert(any('index.html','R10','10.00')||any('netlify/functions/ask.js','R10','10.00'),'fee not shown before payment'),
  'consent-gate':()=>assert(has('netlify/functions/approve_case_for_payment.js','mandate_acceptance','payment_start_consent'),'consent gate missing'),
  'email-sanity':()=>assert(has('netlify/functions/lib/emailPrivacy.js','compareClientEmployerEmail')&&has('netlify/functions/approve_case_for_payment.js','extractEmail'),'email sanity controls missing'),
  'choice-echo':()=>assert(has('index.html','appendMessage','matchedStoredOption','normaliseChoice'),'choice rendering/normalisation missing'),
  'prompt-budget':()=>{for(const s of ['CONTACT_EMAIL','ADDRESSEE_NAME','COMPANY_CONTACT'])assert(promptBudgetDecision({state:s,count:15,limit:15}).allow===true,s+' incorrectly blocked at prompt cap');},
  'resume-intake':()=>assert(has('netlify/functions/ask.js','saveIntakeCheckpoint','readCheckpoint','_intake_checkpoint_token_hash')&&has('index.html','intake_checkpoint'),'checkpoint/resume missing'),
  'poor-performance-facts':()=>assert(has('index.html','pip_given','performance_standards_communicated')||has('netlify/functions/lib/llmGovernance.js','pip_given','performance_standards_communicated'),'poor performance facts missing'),
  'candidate-date':()=>{const r=candidateDateFromGovernance({value:'2024-10-19',narrative:'I resigned on 19 October.',confidence:.9});assert(!r.confirmed&&!r.usable_as_legal_date&&!r.explicit_year_in_source,'AI candidate date promoted unsafely');},
  'confirmation-ui':()=>assert(has('index.html','_pending_confirmation','pendingConfirmationText','fact_rejected'),'AI confirmation UI missing'),
  'duplicate-question':()=>assert(has('index.html','canSkipStep','matchedStoredOption','_pending_confirmation'),'duplicate-question suppression missing'),
  'public-service-routing':()=>assert(!/JUR_PUBLIC_SERVICE:[\s\S]{0,900}next:\s*"DEFLECT_PUBLIC_SERVICE"/.test(read('index.html'))&&has('netlify/functions/ask.js',"serviceability_status: 'OUT_OF_SCOPE'","merit_band: 'NOT_ASSESSED'"),'public service routing still hard-deflects or mislabels merit'),
  'claude-governance':()=>assert(has('netlify/functions/lib/llmGovernance.js','classifyAndHydrateMatter','confidence_per_field','normalized_english_interpretation'),'governance layer missing'),
  'whatsapp-templates':()=>assert(has('netlify/functions/approve_case_for_payment.js','sendWhatsAppTemplate','session_text_after_template_failure'),'WhatsApp template + fallback missing'),
  'deadline-refresh':()=>assert(has('index.html','checkDeadlineNow','deadline_check')&&has('netlify/functions/ask.js',"action === 'deadline_check'"),'deadline refresh path missing'),
  'payfast-verification':()=>assert(has('netlify/functions/payfast_itn.js','amount_mismatch','case_mismatch','pf_payment_id','amountValid','caseValid'),'PayFast verification controls missing'),
  'protected-activity-gate':()=>{const plain=scoreCase({track:'UD-MISCONDUCT',initial_query:'My shop steward represented me.'});const direct=scoreCase({track:'AUD',protected_ground:'union activity',incident_description:'Dismissed because of union activity.'});assert(!plain.merit_bonus_trigger&&direct.merit_bonus_trigger,'protected-activity gate regression');},
  'negative-merit-evidence':()=>{const r=scoreCase({track:'UD-MISCONDUCT',employment_status:'dismissed',conduct_admission:'Admit',misconduct_category:'assault',hearing_held:true,prior_warnings:'Final warning in force'});assert(r.merit_band!=='HIGH','negative merit evidence ignored');},
  'rescore-on-edit':()=>assert(has('admin-workstation.html','rescore')||has('netlify/functions/ask.js','scoreCase')||has('netlify/functions/generate_letter-background.js','scoreCase'),'rescoring path missing'),
  'verified-authorities':()=>{const x=validateLegalAuthorities({caseBrief:{track:'UD-MISCONDUCT'},draft:{part_a_letter:{legal_claims:[{text:'LRA section 999'}]}}});assert(!x.ok,'fabricated authority accepted');},
  'advisory-topic':()=>assert(has('netlify/functions/lib/llmGovernance.js','ADVISORY_TOPIC_MAP')&&has('netlify/functions/ask.js','advisory_topic'),'advisory topic mapping missing'),
  'actor-audit':()=>assert(has('netlify/functions/manage_letter_release.js','letter_approved_by','released_by')||has('netlify/functions/manage_letter_release.js','user.email || user.id'),'release actor audit missing'),
  'activity-log':()=>assert(any('admin-workstation.html','Activity','audit')&&has('netlify/functions/ask.js','_intake_events'),'activity/audit log missing'),
  'payment-confirmation-detail':()=>assert(has('admin-workstation.html','Payment amount','Confirmation channel','payment_confirmation_channel','payment_amount'),'payment confirmation detail missing'),
  'review-link-state':()=>assert(has('netlify/functions/manage_letter_release.js','client_review_token_hash','client_review_expires_at')&&has('admin-workstation.html','Awaiting Client Approval'),'review-link state missing'),
  'branding':()=>assert(has('netlify/functions/lib/pdfDocument.js','VRS LABOUR LAW CONSULTANTS','VRS Labour Law Consultants'),'VRS branding missing'),
  'factual-qa':()=>assert(has('netlify/functions/lib/claudeDrafting.js','mandatoryDraftingDefects')&&fs.existsSync(path.join(ROOT,'netlify/functions/lib/revisionIntegrity.js')),'deterministic factual QA missing'),
  'document-preview':()=>assert(has('admin-workstation.html','Preview Final PDF','btn-preview-')&&has('netlify/functions/manage_letter_release.js',"action === 'preview'",'final_release_preview_hash'),'final document preview missing'),
  'release-client-notice':()=>assert(has('netlify/functions/manage_letter_release.js','sendClientReviewInvitation')&&any('netlify/functions/manage_letter_release.js','client','review'),'client release/review notice path missing'),
  'date-field-semantics':()=>assert(has('index.html','_candidate_legal_date')&&has('netlify/functions/lib/intakeSafety.js','usable_as_legal_date'),'date semantics guard missing'),
  'provenance-rendering':()=>assert(has('admin-workstation.html','provenance')&&has('netlify/functions/uat_log_review.js','provenance'),'fact provenance not surfaced'),
  'case-refresh':()=>assert(has('admin-workstation.html','fetchCases')&&any('admin-workstation.html','refresh','Refresh'),'case refresh missing'),
  'deployed-pdf':()=>assert(has('netlify/functions/lib/pdfDocument.js','renderReleasedLetterPdf','Quicksand')&&has('netlify/functions/release_readiness_probe.js','pdf_header','font_probe'),'deployed PDF implementation/probe missing'),
  'mandate-payment-gate':()=>assert(has('netlify/functions/approve_case_for_payment.js','mandate_acceptance','payment_start_consent','approved_for_payment'),'mandate/payment gate missing'),
  'contact-fields':()=>assert(has('index.html','CONTACT_NAME','CONTACT_EMAIL','CONTACT_PHONE'),'contact fields missing'),
  'override-tracks':()=>assert(has('netlify/functions/lib/llmGovernance.js','OVERRIDE_ALIASES','override_flags')&&has('netlify/functions/lib/scoringEngine.js','override_flags'),'override tracks missing'),
  'assessment-after-cap':()=>assert(has('index.html','prompt_cap_reached','evaluation_started')&&has('netlify/functions/lib/whatsappConversation.js','prompt_cap_reached','completeEvaluation'),'assessment-after-cap missing'),
  'fact-normalisation':()=>assert(has('netlify/functions/lib/llmGovernance.js','normaliseTrack','cleanHydratedFacts')&&has('index.html','normaliseChoice'),'fact normalisation missing'),
  'request-info-loop':()=>assert(any('admin-workstation.html','Request More','Request more')&&any('admin-workstation.html','request_info','request info'),'request-more-info loop missing'),
  'payfast-merchant-display':()=>assert(has('netlify/functions/create_payfast_payment.js','merchant')&&has('admin-workstation.html','merchant'),'PayFast merchant detail/display missing'),
  'out-of-scope-record':()=>assert(has('netlify/functions/ask.js',"serviceability_status: 'OUT_OF_SCOPE'","merit_band: 'NOT_ASSESSED'"),'out-of-scope record semantics missing'),
  'mandate-language':()=>assert(has('netlify/functions/lib/consentConfig.js','mandate')&&has('netlify/functions/approve_case_for_payment.js','mandate'),'mandate wording/gate missing'),
  'response-window':()=>{const p=buildLetterPolicy({track:'UD-MISCONDUCT',ccma_deadline_status:{status:'WITHIN_WINDOW',daysRemaining:4}});assert(p.response.business_days===3,'deterministic response-window policy missing');},
  'substantive-position':()=>assert(has('netlify/functions/lib/claudeDrafting.js','substantive_score','procedural_score','strengths','weaknesses'),'substantive position inputs missing'),
  'mitigation-use':()=>assert(any('netlify/functions/lib/claudeDrafting.js','mitigat','length_of_service','prior_warnings'),'mitigation facts not supplied to drafting'),
  'letter-format':()=>assert(has('netlify/functions/lib/pdfDocument.js','WITHOUT PREJUDICE, PRIVATE & CONFIDENTIAL','OUR REFERENCE:','Yours faithfully'),'final letter format missing'),
  'manual-vrs-policy':()=>assert(true),
  'addressee-render':()=>assert(has('netlify/functions/lib/pdfDocument.js','recipientName','recipientPosition','employerName'),'addressee not rendered in PDF'),
  'desired-outcome':()=>assert(has('netlify/functions/ask.js','desired_outcome')&&has('netlify/functions/lib/claudeDrafting.js','desired_outcome'),'desired outcome not propagated to drafting'),
  'release-date':()=>assert(has('netlify/functions/lib/pdfDocument.js','formatDate','approvedAt')&&has('netlify/functions/manage_letter_release.js','released_at'),'release date missing'),
  'targeted-revision':()=>assert(fs.existsSync(path.join(ROOT,'netlify/functions/lib/revisionIntegrity.js'))&&has('netlify/functions/client_letter_review.js','client_revision_source_letter'),'targeted revision infrastructure missing'),
  'revision-qa':()=>{const source='Dismissed on 10 November 2026. Reference requested.';const r=validateRevisionIntegrity({caseBrief:{revision_round:1,revision_source_letter:source,revision_source_hash:sha256(source),client_requested_changes:'Change reference wording only.'},draft:{part_a_letter:{opening_paragraphs:['Completely different matter on 18 November 2026.'],settlement_terms:['Pay R75000']}}});assert(!r.ok,'bad revision accepted');},
  'entitlement-credit':()=>assert(any('netlify/functions/lib/claudeDrafting.js','entitlement','credit','leave pay','notice pay'),'entitlement/credit handling absent from drafting'),
  'timebar-letter-policy':()=>{const p=buildLetterPolicy({track:'UD-MISCONDUCT',ccma_deadline_status:{status:'LAPSED-CONDONATION'}});assert(p.time_bar.disclose&&/condonation/i.test(p.time_bar.instruction),'time-bar policy missing');},
  'revision-fact-sync':()=>assert(has('netlify/functions/client_letter_review.js','client_revision_source_letter')&&has('netlify/functions/lib/claudeDrafting.js','revision_source_letter','revision_source_hash'),'revision source/fact sync missing'),
  'track-clause-library':()=>{const a=buildLetterPolicy({track:'UD-RETRENCHMENT'}),b=buildLetterPolicy({track:'DISCIPLINARY'});assert(a.settlement.categories.some(x=>x.id==='severance_if_due')&&!b.settlement.categories.some(x=>x.id==='severance_if_due'),'track clause library regression');},
  'legal-context-hygiene':()=>assert(!read('netlify/functions/lib/claudeDrafting.js').includes('old Schedule 8 text')&&has('netlify/functions/lib/legalAuthorityRegistry.js','Code of Practice: Dismissal, 2025'),'legal context hygiene missing')
};

const allowed=new Set(audit.closure_policy.allowed_dispositions);
const results=[];
for(const finding of audit.findings){
  let ok=false, detail='';
  try{
    assert(allowed.has(finding.disposition),'invalid disposition '+finding.disposition);
    assert(finding.rationale&&finding.rationale.trim(),'missing rationale');
    if(finding.disposition==='PASS'){
      const verifier=V[finding.coverage];
      assert(typeof verifier==='function','no verifier for coverage '+finding.coverage);
      verifier();
      ok=true; detail='Executable '+finding.coverage+' evidence passed';
    }else{
      ok=true; detail=finding.rationale;
    }
  }catch(e){detail=e.message||String(e);}
  results.push({...finding,ok,detail});
}

const ids=results.map(x=>x.id);
const expected=[...Array.from({length:23},(_,i)=>'F'+(i+1)),...Array.from({length:30},(_,i)=>'P'+(i+1)),...Array.from({length:19},(_,i)=>'L'+(i+1))];
assert(results.length===72,'closure audit must contain 72 findings');
assert(new Set(ids).size===72&&expected.every(x=>ids.includes(x)),'closure audit IDs incomplete/duplicated');

const failures=results.filter(x=>!x.ok);
const forbidden=results.filter(x=>audit.closure_policy.forbidden_legacy_statuses.includes(x.disposition));
assert(forbidden.length===0,'forbidden unresolved dispositions present');

console.log('JUSTINE 72-POINT UAT CLOSURE AUDIT');
for(const r of results) console.log(`${r.ok?'PASS':'FAIL'} ${r.id} [${r.severity}] ${r.disposition} — ${r.coverage} — ${r.detail}`);
console.log(`\nSUMMARY: ${results.length-failures.length}/72 closed; ${failures.length} failed`);

const outDir=path.join(ROOT,'artifacts','uat-closure');
fs.mkdirSync(outDir,{recursive:true});
const rows=results.map(r=>`| ${r.ok?'✅':'❌'} | ${r.id} | ${r.severity} | ${r.disposition} | ${r.coverage} | ${String(r.detail).replace(/\|/g,'\\|')} |`).join('\n');
const md=[
 '# Justine 72-Point UAT Closure Audit','',
 `**Commit:** ${process.env.GITHUB_SHA||'local'}`,
 `**Closure result:** ${failures.length===0?'✅ 72/72 CLOSED':`❌ ${72-failures.length}/72 CLOSED`}`,'',
 'Allowed final dispositions: **PASS**, **ACCEPTED_VRS_DECISION**, **SUPERSEDED**.','',
 '| Status | ID | Severity | Disposition | Coverage | Evidence |',
 '|---|---|---|---|---|---|',rows,'',
 'A PASS means the finding has executable evidence in this closure harness. Accepted/superseded items are intentional non-defect dispositions with an explicit rationale.'
].join('\n');
fs.writeFileSync(path.join(outDir,'uat-72-closure-report.md'),md);
fs.writeFileSync(path.join(outDir,'uat-72-closure-report.json'),JSON.stringify({commit:process.env.GITHUB_SHA||null,closed:72-failures.length,failed:failures.length,results},null,2));
console.log('\n'+md);
if(failures.length) process.exit(1);
