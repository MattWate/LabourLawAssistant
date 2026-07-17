const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Token' }) };
    }
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid Token' }) };

    try {
        const { id, draft_letter, letter_status, case_facts, client_name, issue_summary, status } = JSON.parse(event.body || '{}');
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Case ID required' }) };

        const updatePayload = { updated_at: new Date().toISOString() };
        if (draft_letter !== undefined) updatePayload.draft_letter = draft_letter;
        if (letter_status !== undefined) updatePayload.letter_status = letter_status;
        if (case_facts !== undefined) updatePayload.case_facts = case_facts;
        if (status !== undefined) updatePayload.status = status;
        if (client_name !== undefined) updatePayload.client_name = client_name;
        if (issue_summary !== undefined) updatePayload.issue_summary = issue_summary;

        const { data, error } = await supabase.from('cases').update(updatePayload).eq('id', id).select().single();
        if (error) throw error;

        let paymentResult = null;
        let paymentError = null;

        // In the workstation, approving the final letter is the lawyer's
        // authorisation to invite payment. This keeps the operational flow to:
        // generate -> edit -> approve -> payment link sent on WhatsApp.
        if (letter_status === 'approved') {
            try {
                const { handler: approveForPayment } = require('./approve_case_for_payment');
                const approvalResponse = await approveForPayment({
                    httpMethod: 'POST',
                    headers: { authorization: authHeader },
                    body: JSON.stringify({ caseId: id })
                });
                const approvalBody = JSON.parse(approvalResponse.body || '{}');
                if (approvalResponse.statusCode >= 400) {
                    throw new Error(approvalBody.error || 'Payment request could not be created');
                }
                paymentResult = approvalBody;
            } catch (approvalError) {
                paymentError = approvalError.message;
                console.error('Letter approved but payment request failed:', {
                    caseId: id,
                    error: approvalError.message
                });

                // Keep the approved letter safely stored and make the failed
                // next step visible in the case queue for manual recovery.
                await supabase.from('cases').update({
                    status: 'approved_payment_failed',
                    updated_at: new Date().toISOString()
                }).eq('id', id);
            }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                case: data,
                payment_request: paymentResult,
                payment_error: paymentError
            })
        };
    } catch (error) {
        console.error('Database Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
