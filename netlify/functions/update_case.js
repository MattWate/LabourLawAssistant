const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event, context) => {
    // Only allow POST requests for updates
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { id, draft_letter, letter_status, case_facts } = JSON.parse(event.body);

        if (!id) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Case ID required' }) };
        }

        // Build the update payload dynamically
        const updatePayload = { updated_at: new Date().toISOString() };
        if (draft_letter !== undefined) updatePayload.draft_letter = draft_letter;
        if (letter_status !== undefined) updatePayload.letter_status = letter_status;
        if (case_facts !== undefined) updatePayload.case_facts = case_facts;

        // Update the case in Supabase
        const { data, error } = await supabase
            .from('cases')
            .update(updatePayload)
            .eq('id', id)
            .select();

        if (error) throw error;

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ success: true, case: data[0] })
        };

    } catch (error) {
        console.error("Database Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
