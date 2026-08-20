const { createClient } = require('@supabase/supabase-js');
const { withCaseReference } = require('./lib/caseReference');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function isWpEligible(facts = {}) {
    if (facts.effective_decision?.wp_eligible === true) return true;
    if (facts.admin_override?.wp_eligible === true) return true;
    return facts.wp_eligible === true;
}

function normaliseCaseForWorkstation(caseRow = {}) {
    const referenced = withCaseReference(caseRow);
    const facts = { ...(referenced.case_facts || {}) };

    // The lawyer's effective WP decision controls whether drafting is
    // available. It must not depend on whether the intake explicitly set a
    // separate wants_letter flag.
    if (isWpEligible(facts)) {
        facts.wants_letter = true;
    }

    return {
        ...referenced,
        case_facts: facts
    };
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Authentication Token' }) };
    }

    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${token}`
            }
        }
    });

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid or Expired Token' }) };
    }

    try {
        const { data, error } = await supabase
            .from('cases')
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) throw error;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify((data || []).map(normaliseCaseForWorkstation))
        };
    } catch (error) {
        console.error('Database Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
