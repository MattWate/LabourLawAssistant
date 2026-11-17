const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = url && key ? createClient(url, key) : null;
const response = (statusCode, body) => ({ statusCode, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' }, body:JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return response(405, {error:'Method Not Allowed'});
  if (!db) return response(503, {error:'Payment override unavailable: service-role configuration missing'});
  try {
    const header = event.headers?.authorization || event.headers?.Authorization || '';
    if (!header.startsWith('Bearer ')) return response(401, {error:'Authentication required'});
    const {data:{user},error:authError} = await db.auth.getUser(header.slice(7));
    if (authError || !user?.email) return response(401, {error:'Invalid session'});

    // Fail closed until the two authorised administrator emails are configured.
    const permitted = String(process.env.PAYMENT_OVERRIDE_ADMIN_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!permitted.includes(user.email.trim().toLowerCase())) return response(403, {error:'You are not authorised to confirm payments manually'});

    const body = JSON.parse(event.body || '{}');
    const caseId = String(body.caseId || '').trim();
    const reason = String(body.reason || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(caseId)) return response(400, {error:'Valid case ID required'});
    if (reason.length < 5 || reason.length > 500) return response(400, {error:'Enter a short confirmation reason (5–500 characters)'});
    if (body.confirmed !== true) return response(400, {error:'Explicit confirmation that payment was checked is required'});

    const {data:caseData,error:caseError} = await db.from('cases').select('id,status,payment_status,paid_at,wp_generation_unlocked,case_facts').eq('id',caseId).maybeSingle();
    if (caseError) throw caseError;
    if (!caseData) return response(404,{error:'Case not found'});
    if (caseData.payment_status === 'paid') return response(200,{success:true,already_confirmed:true,message:'This case is already paid; no further action taken'});
    if (caseData.payment_status !== 'pending') return response(409,{error:'Only cases with a pending payment can be manually confirmed'});

    const {data:payments,error:payError} = await db.from('payments').select('id,m_payment_id,amount,status,created_at')
      .eq('case_id',caseId).eq('provider','payfast').eq('status','pending').order('created_at',{ascending:false}).limit(2);
    if (payError) throw payError;
    if (!payments?.length) return response(409,{error:'No pending PayFast payment record found'});
    if (payments.length > 1) return response(409,{error:'Multiple pending payments found; investigate before overriding'});
    const payment = payments[0];
    const at = new Date().toISOString();
    const facts = caseData.case_facts || {};
    const evidence = {source:'admin_override',recorded_by:user.email,recorded_by_id:user.id,recorded_at:at,reason,
      m_payment_id:payment.m_payment_id,amount:payment.amount};
    const updatedFacts = {...facts,payment_status:'paid',paid_at:at,wp_generation_unlocked:true,
      payment_verification_source:'admin_override',manual_payment_confirmation:evidence};

    // Conditional update is the single unlock gate. A concurrent ITN or repeat
    // click can only win this gate once; losers must not restart case processing.
    const {data:claimed,error:updateError} = await db.from('cases').update({
      payment_status:'paid',paid_at:at,wp_generation_unlocked:true,
      status:caseData.status === 'payment_pending' ? 'paid_ready_for_drafting' : caseData.status,
      case_facts:updatedFacts,updated_at:at
    }).eq('id',caseId).eq('payment_status','pending').select('id');
    if (updateError) throw updateError;
    if (!claimed?.length) return response(200,{success:true,already_confirmed:true,message:'Payment was confirmed by another request'});

    // The case is the authoritative unlock; payment record is a supporting audit.
    const {error:paymentUpdateError} = await db.from('payments').update({status:'manual_confirmed',updated_at:at})
      .eq('id',payment.id).eq('status','pending');
    if (paymentUpdateError) {
      console.error('Manual payment audit update failed', {caseId,paymentId:payment.id,error:paymentUpdateError.message});
      return response(200,{success:true,warning:'Case unlocked, but payment audit update failed. Please investigate.',payment_id:payment.m_payment_id});
    }
    console.info('Manual payment override recorded',{caseId,paymentId:payment.m_payment_id,admin:user.id});
    return response(200,{success:true,message:'Payment manually confirmed. Drafting is unlocked.',payment_id:payment.m_payment_id});
  } catch (error) {
    console.error('manual payment confirmation error',error);
    return response(500,{error:'Could not confirm payment; check server logs'});
  }
};
