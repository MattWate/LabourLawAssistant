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
        // Build the Skeleton "Blank" Facts
        const blankFacts = {
            client_name: "New Manual Client",
            contact_info: "",
            employer_name: "",
            employer_contact_details: "",
            incident_date: "",
            incident_description: "",
            hearing_held: null,
            wants_letter: true, // Forces the 'Generate Draft' button to appear in the UI
            employment_status: "",
            paid_suspension: null,
            constructive_dismissal: null,
            contract_type: "",
            sector: "",
            merit_assessment: "Manual Override",
            legal_reasoning: "Matter created manually by Attorney. No preliminary AI assessment performed."
        };

        const dbPayload = {
            client_name: "New Manual Client",
            issue_summary: "Manual entry pending...",
            case_facts: blankFacts,
            status: 'requires_attorney',
            letter_status: 'not_drafted'
        };

        // Insert and return the new row data securely
        const { data, error } = await supabase.from('cases').insert(dbPayload).select().single();
        
        if (error) throw error;

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ success: true, case: data })
        };
    } catch (error) {
        console.error("Creation Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
