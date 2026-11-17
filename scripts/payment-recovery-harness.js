const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
const CASE='12345678-1234-4234-8234-123456789abc';
let rows, sent=0;
const copy=x=>JSON.parse(JSON.stringify(x));
function reset(){
 rows={cases:[{id:CASE,status:'payment_pending',payment_status:'pending',case_facts:{},wp_generation_unlocked:false}],
 payments:[{id:'payment-1',case_id:CASE,provider:'payfast',m_payment_id:'PAY-1',amount:950,status:'pending',created_at:'2026-11-17'}],
 whatsapp_conversations:[{case_id:CASE,from_number:'27000000000',phone_number_id:'test'}]};
 sent=0;
}
class Q {
 constructor(table){this.table=table;this.filters=[];this.patch=null;this.max=null;}
 select(){return this;}
 eq(k,v){this.filters.push([k,v]);return this;}
 order(){return this;}
 limit(n){this.max=n;return this;}
 update(p){this.patch=p;return this;}
 async run(single=false){
  let a=rows[this.table].filter(r=>this.filters.every(([k,v])=>r[k]===v));
  if(this.max)a=a.slice(0,this.max);
  if(this.patch)a.forEach(r=>Object.assign(r,copy(this.patch)));
  return {data:single?(a.length?copy(a[0]):null):copy(a),error:null};
 }
 maybeSingle(){return this.run(true);}
 single(){return this.run(true);}
 then(ok,fail){return this.run().then(ok,fail);}
}
const db={auth:{async getUser(token){return {data:{user:token==='sasha'?{id:'a',email:'sasha@test.invalid'}:token==='etienne'?{id:'b',email:'etienne@test.invalid'}:token==='outsider'?{id:'c',email:'other@test.invalid'}:null},error:null};}},from:t=>new Q(t)};
process.env.SUPABASE_URL='https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY='test';
process.env.PAYMENT_OVERRIDE_ADMIN_EMAILS='sasha@test.invalid,etienne@test.invalid';
process.env.PAYFAST_MERCHANT_ID='test-merchant';
Module._load=function(req,parent,isMain){
 if(req==='@supabase/supabase-js')return {createClient:()=>db};
 if(parent&&parent.filename.endsWith('/payfast_itn.js')&&req==='./lib/payfast')return {
 parseFormBody:x=>Object.fromEntries(new URLSearchParams(x)),
 verifyRawItnSignature:()=>true,validateWithPayfast:async()=>({ok:true,body:'VALID'})};
 if(parent&&parent.filename.endsWith('/payfast_itn.js')&&req==='./lib/whatsapp')return {
 sendWhatsAppText:async()=>{sent++},sendWhatsAppTemplate:async()=>{sent++}};
 return original.apply(this,arguments);
};
const manual=require('../netlify/functions/manual_confirm_payment').handler;
const itn=require('../netlify/functions/payfast_itn').handler;
Module._load=original;
function request(token='sasha',more={}){return manual({httpMethod:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({caseId:CASE,reason:'Checked PayFast dashboard',confirmed:true,...more})});}
function notification(status='COMPLETE',amount='950.00',payment='PAY-1'){
 return itn({httpMethod:'POST',body:new URLSearchParams({m_payment_id:payment,pf_payment_id:'PF-1',merchant_id:'test-merchant',payment_status:status,amount_gross:amount,custom_str1:CASE}).toString()});
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
 reset();
 await test('unauthorised account blocked',async()=>assert.equal((await request('outsider')).statusCode,403));
 await test('missing reason rejected',async()=>assert.equal((await request('sasha',{reason:'a'})).statusCode,400));
 await test('missing acknowledgement rejected',async()=>assert.equal((await request('sasha',{confirmed:false})).statusCode,400));
 await test('admin unlocks pending case',async()=>{
  assert.equal((await request()).statusCode,200);
  assert.equal(rows.cases[0].payment_status,'paid');
  assert.equal(rows.cases[0].wp_generation_unlocked,true);
  assert.equal(rows.cases[0].status,'paid_ready_for_drafting');
  assert.equal(rows.payments[0].status,'manual_confirmed');
  assert.equal(rows.cases[0].case_facts.manual_payment_confirmation.recorded_by,'sasha@test.invalid');
 });
 await test('repeat confirmation is harmless',async()=>{
  const at=rows.cases[0].paid_at;
  assert.equal(JSON.parse((await request('etienne')).body).already_confirmed,true);
  assert.equal(rows.cases[0].paid_at,at);
 });
 await test('late paid ITN preserves drafting and no WhatsApp duplicate',async()=>{
  rows.cases[0].status='drafting_in_progress';
  await notification();
  assert.equal(rows.cases[0].status,'drafting_in_progress');
  assert.equal(rows.cases[0].case_facts.payment_verification_source,'admin_override');
  assert.equal(sent,0);
 });
 await test('late failed ITN does not revoke case',async()=>{
  await notification('FAILED');
  assert.equal(rows.cases[0].payment_status,'paid');
  assert.equal(rows.cases[0].status,'drafting_in_progress');
 });
 reset();
 await test('ITN normal completion and duplicate',async()=>{
  await notification();assert.equal(rows.cases[0].payment_status,'paid');
  assert.equal(sent,1);
  await notification();assert.equal(sent,1);
 });
 reset();
 await test('ITN amount mismatch does not unlock',async()=>{await notification('COMPLETE','1.00');assert.equal(rows.cases[0].payment_status,'pending')});
 reset();
 await test('unknown ITN payment does not unlock',async()=>{await notification('COMPLETE','950.00','unknown');assert.equal(rows.cases[0].payment_status,'pending')});
 console.log('Payment recovery harness passed: '+count+' tests');
})().catch(e=>{console.error(e);process.exitCode=1});
