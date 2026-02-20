const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event, context) => {
    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Fetch all cases, ordered by the most recently updated
        const { data, error } = await supabase
            .table('cases')
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) {
            throw error;
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        };

    } catch (error) {
        console.error("Database Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
