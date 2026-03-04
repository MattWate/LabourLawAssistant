const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // --- SECURITY CHECK (Verify the Admin Token) ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Authentication Token' }) };
    }

    try {
        const { caseId } = JSON.parse(event.body);
        if (!caseId) return { statusCode: 400, body: JSON.stringify({ error: 'Case ID required' }) };

        // 1. Fetch Case Facts
        const { data: caseData, error: caseErr } = await supabase.from('cases').select('case_facts').eq('id', caseId).single();
        if (caseErr || !caseData) throw new Error("Case not found");
        
        const facts = caseData.case_facts;

        // 2. Fetch ALL AI and Firm Settings
        const { data: settingData } = await supabase.from('system_settings').select('*');
        const settings = {};
        if (settingData) {
            settingData.forEach(row => settings[row.setting_name] = row.setting_value);
        }
        const activeLLM = settings.active_llm || 'gemini';
        
        // Extract Firm details
        const firmName = settings.firm_name || 'Legal Consultants';
        const firmAddress = settings.firm_address || '123 Legal Way, South Africa';
        const firmContact = settings.firm_contact || 'info@legalconsultants.co.za';

        // 3. The Drafter Prompt
        const prompt = `
        You are a Senior South African Labour Lawyer working for a firm named "${firmName}". 
        Write a formal, highly professional "Without Prejudice" demand letter based on the following case facts.
        
        --- FIRM LETTERHEAD INFO ---
        Firm Name: ${firmName}
        Firm Address: ${firmAddress}
        Firm Contact: ${firmContact}
        ----------------------------

        CLIENT NAME: ${facts.client_name || 'N/A'}
        EMPLOYER NAME: ${facts.employer_name || 'N/A'}
        EMPLOYER CONTACT: ${facts.employer_contact_details || 'N/A'}
        DATE OF INCIDENT: ${facts.incident_date || 'N/A'}
        HEARING HELD: ${facts.hearing_held ? 'Yes' : 'No'}
        INCIDENT SUMMARY: ${facts.incident_description || 'N/A'}

        REQUIREMENTS:
        1. Start by placing the FIRM LETTERHEAD INFO at the very top of the document, formatted professionally like a real letterhead.
        2. Below the letterhead and date, include "WITHOUT PREJUDICE" centered.
        3. Format as a formal letter addressed to the Employer.
        4. Clearly state the dispute (e.g., Unfair Dismissal, Unfair Labour Practice) based on the summary.
        5. Make a firm demand (e.g., reinstatement, compensation, or rectification).
        6. Conclude by stating that failure to respond favorably within 7 days will result in the matter being referred to the CCMA (Commission for Conciliation, Mediation and Arbitration) or Labour Court.
        7. Sign off as "${firmName}".
        8. Return ONLY the letter text. Do not include markdown blocks, intro, or outro text.
        `;

        let letterText = "";

        // 4. Generate Letter
        if (activeLLM === 'openai' && openai) {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o", 
                messages: [{ role: "user", content: prompt }]
            });
            letterText = completion.choices[0].message.content.trim();
        } else {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const result = await model.generateContent(prompt);
            letterText = result.response.text().trim();
        }

        // 5. Save the generated letter to Supabase
        await supabase.from('cases').update({
            draft_letter: letterText,
            letter_status: 'pending_review'
        }).eq('id', caseId);

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ success: true, letter: letterText })
        };

    } catch (error) {
        console.error("Drafting Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
