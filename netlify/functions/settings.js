const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event, context) => {
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
        if (event.httpMethod === 'GET') {
            const { data, error } = await supabase.from('system_settings').select('*');
            if (error) throw error;

            const settings = {};
            if (data) data.forEach(row => settings[row.setting_name] = row.setting_value);
            if (!settings.active_llm) settings.active_llm = 'gemini';

            return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) };
        }

        if (event.httpMethod === 'POST') {
            const payload = JSON.parse(event.body);
            const upsertData = Object.keys(payload).map(key => ({
                setting_name: key, setting_value: payload[key], updated_at: new Date().toISOString() 
            }));

            const { error } = await supabase.from('system_settings').upsert(upsertData);
            if (error) throw error;

            return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error("Settings API Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
