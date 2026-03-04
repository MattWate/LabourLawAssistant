const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event, context) => {
    try {
        // Handle fetching the current setting
        if (event.httpMethod === 'GET') {
            const { data, error } = await supabase
                .from('system_settings')
                .select('*')
                .eq('setting_name', 'active_llm')
                .single();

            // If no setting exists yet, default to gemini
            const active_llm = data ? data.setting_value : 'gemini';

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active_llm })
            };
        }

        // Handle updating the setting
        if (event.httpMethod === 'POST') {
            const { active_llm } = JSON.parse(event.body);

            // Upsert will update the existing row, or insert it if it doesn't exist
            const { error } = await supabase
                .from('system_settings')
                .upsert({ 
                    setting_name: 'active_llm', 
                    setting_value: active_llm, 
                    updated_at: new Date().toISOString() 
                });

            if (error) throw error;

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ success: true, active_llm })
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
