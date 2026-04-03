const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // --- SECURITY CHECK ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Token' }) };
    }
    const token = authHeader.replace('Bearer ', '');
    
    // Request-specific client authenticated as the Admin user
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid Token' }) };
    // ----------------------

    try {
        // Extract client_name and issue_summary from the payload
        const { id, draft_letter, letter_status, case_facts, client_name, issue_summary } = JSON.parse(event.body);
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Case ID required' }) };

        const updatePayload = { updated_at: new Date().toISOString() };
        if (draft_letter !== undefined) updatePayload.draft_letter = draft_letter;
        if (letter_status !== undefined) updatePayload.letter_status = letter_status;
        if (case_facts !== undefined) updatePayload.case_facts = case_facts;
        // Save top-level data so the database stays perfectly synced
        if (client_name !== undefined) updatePayload.client_name = client_name;
        if (issue_summary !== undefined) updatePayload.issue_summary = issue_summary;

        const { data, error } = await supabase.from('cases').update(updatePayload).eq('id', id).select();
        if (error) throw error;

        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, case: data[0] }) };

    } catch (error) {
        console.error("Database Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
