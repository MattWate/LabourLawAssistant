const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { FIXTURES } = require('./lib/liveDraftingFixtures');
const { buildCaseBrief } = require('./lib/claudeDrafting');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const OWNER = 'assistant-temporary-run-2026-11-10';

function json(statusCode, body){return {statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function baseUrl(event){
  const host=event.headers?.host||event.headers?.['x-forwarded-host'];
  const proto=event.headers?.['x-forwarded-proto']||'https';
  if(host) return `${proto}://${host}`;
  return String(process.env.DEPLOY_PRIME_URL||process.env.URL||'').replace(/\/$/,'');
}
function sign(raw){return crypto.createHmac('sha256',INTERNAL_SIGNING_KEY).update(raw,'utf8').digest('hex')}

async function loadCase(caseId){
  const {data,error}=await supabase.from('cases')
    .select('id,status,letter_status,draft_letter,case_facts,payment_status,wp_generation_unlocked,created_at,updated_at')
    .eq('id',caseId).maybeSingle();
  if(error) throw error;
  return data;
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=='GET') return json(405,{error:'Method Not Allowed'});
    const q=event.queryStringParameters||{};
    const action=String(q.action||'start');

    if(action==='start'){
      const fixture=String(q.fixture||'');
      const selected=FIXTURES[fixture];
      if(!selected) return json(400,{error:'fixture must be misconduct, performance or retrenchment'});
      const now=new Date().toISOString();
      const testFacts={
        ...selected.facts,
        wp_eligible:true,
        payment_status:'paid',
        wp_generation_unlocked:true,
        hard_disqualifier:false,
        harness_test:true,
        harness_fixture:fixture,
        harness_label:selected.name,
        harness_requested_by:OWNER,
        harness_created_at:now,
        harness_source_facts:selected.facts,
        wp_letter_status:'HARNESS_QUEUED'
      };
      const {data:inserted,error:insertError}=await supabase.from('cases').insert({
        client_name:'[HARNESS] '+(selected.facts.client_name||selected.name),
        contact_info:'temporary-drafting-harness',
        issue_summary:'[TEMPORARY QA] '+(selected.facts.incident_description||selected.name),
        case_facts:testFacts,
        status:'paid_ready_for_drafting',
        letter_status:'not_drafted',
        payment_status:'paid',
        paid_at:now,
        wp_generation_unlocked:true
      }).select('id').single();
      if(insertError) throw insertError;

      const caseId=inserted.id;
      const raw=JSON.stringify({caseId,sender_variant:'VRS',client_side:'employee'});
      const queued=await fetch(baseUrl(event)+'/.netlify/functions/generate_letter-background',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-vrs-internal-signature':sign(raw)},
        body:raw
      });
      if(!queued.ok && queued.status!==202){
        const t=await queued.text();
        return json(500,{error:'queue failed',caseId,detail:t.slice(0,500)});
      }
      return json(202,{status:'queued',caseId,fixture,label:selected.name});
    }

    const caseId=String(q.caseId||'');
    if(!caseId) return json(400,{error:'caseId required'});
    const row=await loadCase(caseId);
    if(!row) return json(404,{error:'case not found'});
    const facts=row.case_facts||{};
    if(facts.harness_test!==true||facts.harness_requested_by!==OWNER) return json(403,{error:'Forbidden'});

    if(action==='delete'){
      const {error}=await supabase.from('cases').delete().eq('id',caseId);
      if(error) throw error;
      return json(200,{success:true});
    }

    if(action!=='status') return json(400,{error:'Unknown action'});

    const sourceFacts=facts.harness_source_facts||{};
    const failed=row.letter_status==='generation_failed'||['GENERATION_FAILED','QUALITY_REVIEW_FAILED','QUEUE_FAILED'].includes(facts.wp_letter_status);
    const completed=row.letter_status==='pending_review'&&Boolean(row.draft_letter);

    if(failed){
      return json(200,{
        status:'failed',caseId,fixture:facts.harness_fixture,label:facts.harness_label,
        stage:facts.wp_letter_status||row.letter_status,error:facts.wp_generation_error||'Drafting failed',
        case_brief:buildCaseBrief({facts:sourceFacts,senderVariant:'VRS',clientSide:'employee'}),
        letter:facts.wp_failed_draft_preview||'',structure:facts.wp_letter_structure||null,
        supervisory_assessment:facts.wp_supervisory_assessment||null,
        run_summary:{
          drafting_quality_score:facts.wp_supervisory_assessment?.drafting_quality_score??null,
          quality_floor_met:false,
          redraft_performed:facts.wp_supervisory_assessment?.redraft_performed??false,
          initial_drafting_quality_score:facts.wp_supervisory_assessment?.initial_drafting_quality_score??null,
          final_drafting_quality_score:facts.wp_supervisory_assessment?.final_drafting_quality_score??null
        },
        skill_hash:facts.wp_skill_hash||null,skill_manifest:facts.wp_skill_manifest||null,llm_call_logs:facts.llm_call_logs||[]
      });
    }

    if(!completed){
      return json(200,{status:'running',caseId,stage:facts.wp_letter_status||row.letter_status||row.status,updated_at:row.updated_at});
    }

    return json(200,{
      status:'completed',caseId,fixture:facts.harness_fixture,label:facts.harness_label,
      generated_at:facts.wp_generation_completed_at||row.updated_at,
      case_brief:buildCaseBrief({facts:sourceFacts,senderVariant:'VRS',clientSide:'employee'}),
      letter:row.draft_letter,structure:facts.wp_letter_structure||null,
      supervisory_assessment:facts.wp_supervisory_assessment||null,
      run_summary:{
        drafting_quality_score:facts.wp_supervisory_assessment?.drafting_quality_score??null,
        quality_floor_met:facts.wp_supervisory_assessment?.quality_floor_met??null,
        redraft_performed:facts.wp_supervisory_assessment?.redraft_performed??false,
        initial_drafting_quality_score:facts.wp_supervisory_assessment?.initial_drafting_quality_score??null,
        final_drafting_quality_score:facts.wp_supervisory_assessment?.final_drafting_quality_score??null
      },
      skill_hash:facts.wp_skill_hash||null,skill_manifest:facts.wp_skill_manifest||null,llm_call_logs:facts.llm_call_logs||[]
    });
  }catch(e){return json(500,{error:String(e.message||e)})}
};