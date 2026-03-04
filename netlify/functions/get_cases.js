const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event, context) => {
    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // --- SECURITY CHECK (Verify the Admin Token) ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Authentication Token' }) };
    }

    const token = authHeader.replace('Bearer ', '');
    
    // Initialize a request-specific Supabase client WITH the user's token.
    // This ensures Row Level Security (RLS) knows exactly who is making the request!
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${token}`
            }
        }
    });
    
    // Ask Supabase if this token is a real, logged-in admin user
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    
    if (authErr || !user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid or Expired Token' }) };
    }
    // ------------------------------------------------

    try {
        // Fetch all cases, ordered by the most recently updated.
        // Because we attached the token to the client above, RLS will allow this request.
        const { data, error } = await supabase
            .from('cases')
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
