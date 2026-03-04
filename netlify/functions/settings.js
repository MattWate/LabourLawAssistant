const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event, context) => {
    try {
        // Handle fetching the current settings
        if (event.httpMethod === 'GET') {
            const { data, error } = await supabase
                .from('system_settings')
                .select('*');

            if (error) throw error;

            // Convert array of database rows to a single clean object
            const settings = {};
            if (data) {
                data.forEach(row => settings[row.setting_name] = row.setting_value);
            }
            
            // Set default if missing
            if (!settings.active_llm) settings.active_llm = 'gemini';

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings)
            };
        }

        // Handle updating multiple settings at once
        if (event.httpMethod === 'POST') {
            const payload = JSON.parse(event.body);

            // Create array of objects for bulk database upsert
            const upsertData = Object.keys(payload).map(key => ({
                setting_name: key, 
                setting_value: payload[key], 
                updated_at: new Date().toISOString() 
            }));

            const { error } = await supabase
                .from('system_settings')
                .upsert(upsertData);

            if (error) throw error;

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ success: true })
            };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error("Settings API Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
