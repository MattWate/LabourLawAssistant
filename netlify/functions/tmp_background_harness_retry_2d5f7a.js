const crypto=require('crypto');
const {createClient}=require('@supabase/supabase-js');
const {FIXTURES}=require('./lib/liveDraftingFixtures');
const {buildCaseBrief}=require('./lib/claudeDrafting');

const URL=process.env.SUPABASE_URL;
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_KEY;
const SIGN=process.env.LETTER_GENERATION_INTERNAL_SECRET||process.env.SUPABASE_SERVICE_ROLE_KEY;
const db=createClient(URL,KEY);

function out(code,body){return{statusCode:code,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function base(event){const h=event.headers.host||event.headers['x-forwarded-host'];const p=event.headers['x-forwarded-proto']||'https';return p+'://'+h}
function sig(raw){return crypto.createHmac('sha256',SIGN).update(raw,'utf8').digest('hex')}

async function row(id){
  const {data,error}=await db.from('cases').select('id,status,letter_status,draft_letter,case_facts,payment_status,wp_generation_unlocked,updated_at').eq('id',id).maybeSingle();
  if(error) throw error; return data;
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=='GET') return out(405,{error:'GET only'});
    const q=event.queryStringParameters||{};
    const action=q.action||'start';

    if(action==='start'){
      const fixture=q.fixture;
      const f=FIXTURES[fixture];
      if(!f) return out(400,{error:'bad fixture'});
      const now=new Date().toISOString();
      const facts={...f.facts,wp_eligible:true,payment_status:'paid',wp_generation_unlocked:true,hard_disqualifier:false,harness_test:true,harness_fixture:fixture,harness_created_at:now,harness_source_facts:f.facts,wp_letter_status:'HARNESS_QUEUED'};
      const {data,error}=await db.from('cases').insert({
        client_name:'[HARNESS] '+(f.facts.client_name||f.name),
        contact_info:'temporary-drafting-harness',
        issue_summary:'[TEMPORARY QA] '+(f.facts.incident_description||f.name),
        case_facts:facts,status:'paid_ready_for_drafting',letter_status:'not_drafted',payment_status:'paid',paid_at:now,wp_generation_unlocked:true
      }).select('id').single();
      if(error) throw error;
      const raw=JSON.stringify({caseId:data.id,sender_variant:'VRS',client_side:'employee'});
      const queued=await fetch(base(event)+'/.netlify/functions/generate_letter-background',{
        method:'POST',headers:{'Content-Type':'application/json','x-vrs-internal-signature':sig(raw)},body:raw
      });
      const txt=await queued.text();
      if(!queued.ok&&queued.status!==202) return out(500,{error:'queue failed',caseId:data.id,http_status:queued.status,detail:txt.slice(0,500)});
      return out(202,{caseId:data.id,fixture,status:'queued'});
    }

    if(action==='status'){
      const r=await row(q.caseId);
      if(!r) return out(404,{error:'not found'});
      const f=r.case_facts||{};
      if(f.harness_test!==true) return out(403,{error:'not harness'});
      const failed=r.letter_status==='generation_failed'||['GENERATION_FAILED','QUALITY_REVIEW_FAILED','QUEUE_FAILED','HARNESS_QUEUE_FAILED'].includes(f.wp_letter_status);
      const done=r.letter_status==='pending_review'&&!!r.draft_letter;
      if(!failed&&!done) return out(200,{status:'running',caseId:r.id,stage:f.wp_letter_status||r.letter_status||r.status,updated_at:r.updated_at});
      const source=f.harness_source_facts||{};
      return out(200,{
        status:failed?'failed':'completed',caseId:r.id,fixture:f.harness_fixture,
        stage:f.wp_letter_status||r.letter_status,error:f.wp_generation_error||null,
        case_brief:buildCaseBrief({facts:source,senderVariant:'VRS',clientSide:'employee'}),
        letter:r.draft_letter||f.wp_failed_draft_preview||'',
        structure:f.wp_letter_structure||null,
        supervisory_assessment:f.wp_supervisory_assessment||null,
        run_summary:{
          drafting_quality_score:f.wp_supervisory_assessment?.drafting_quality_score??null,
          quality_floor_met:f.wp_supervisory_assessment?.quality_floor_met??false,
          redraft_performed:f.wp_supervisory_assessment?.redraft_performed??false,
          initial_drafting_quality_score:f.wp_supervisory_assessment?.initial_drafting_quality_score??null,
          final_drafting_quality_score:f.wp_supervisory_assessment?.final_drafting_quality_score??null
        },
        skill_hash:f.wp_skill_hash||null,skill_manifest:f.wp_skill_manifest||null,llm_call_logs:f.llm_call_logs||[]
      });
    }

    if(action==='delete'){
      const r=await row(q.caseId);
      if(!r) return out(200,{success:true});
      if(r.case_facts?.harness_test!==true) return out(403,{error:'not harness'});
      const {error}=await db.from('cases').delete().eq('id',q.caseId);
      if(error) throw error;
      return out(200,{success:true});
    }

    return out(400,{error:'bad action'});
  }catch(e){return out(500,{error:String(e.message||e)})}
};