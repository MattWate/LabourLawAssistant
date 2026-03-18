const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Make sure this is your service_role key in Netlify!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const action = body.action; // Expects "evaluate" or "close"

        // ==========================================
        // ACTION 1: EVALUATE & PITCH
        // ==========================================
        if (action === "evaluate") {
            const facts = body.facts;
            
            // 1. Build a search query based on what they told us
            const searchQuery = `${facts.incident_description || ''} ${facts.sector || ''} unfair dismissal labour practice`;
            
            // 2. Search Database (RAG) using Gemini Embeddings
            const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
            const embeddingResult = await embeddingModel.embedContent(searchQuery);
            
            const { data: chunks } = await supabase.rpc('hybrid_search', {
                query_text: searchQuery,
                query_embedding: embeddingResult.embedding.values,
                match_count: 5, 
                full_text_weight: 1.0, 
                semantic_weight: 2.0, 
                rrf_k: 50
            });
            const contextText = chunks ? chunks.map(c => c.content).join("\n\n") : "No specific case law found.";

            // 3. Check Admin Settings for Active LLM
            const { data: settingData } = await supabase.from('system_settings').select('setting_value').eq('setting_name', 'active_llm').single();
            const activeLLM = settingData ? settingData.setting_value : 'gemini';

            // 4. Create the Evaluation Prompt
            const prompt = `
            You are Justine, a highly knowledgeable South African Labour Law Assistant. 
            Review these collected facts and the legal context, then return a JSON object with a 'pitch' and 'legal_reasoning'.
            
            FACTS:
            ${JSON.stringify(facts, null, 2)}
            
            LEGAL CONTEXT:
            ${contextText}
            
            INSTRUCTIONS FOR THE PITCH:
            1. Validate their experience warmly based on the facts (e.g., "Based on what you've told me, especially since they didn't hold a hearing...").
            2. Tell them the law is likely on their side.
            3. Pitch our "Demand Letter" service. Tell them our legal team will review the file and draft a formal demand letter to their employer for a small fixed fee.
            4. End by asking: "Would you like our legal team to draft this letter for you?"
            
            RETURN ONLY A JSON OBJECT WITH THIS EXACT STRUCTURE:
            {
              "pitch": "Your warm, conversational response.",
              "legal_reasoning": "Markdown bullet points explaining why the law is on their side based on the facts and context."
            }
            `;

            let aiResponse = null;

            // 5. Ask the chosen LLM to evaluate and generate the pitch
            if (activeLLM === 'openai' && openai) {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "You are a legal JSON processor. Always return strictly formatted JSON." },
                        { role: "user", content: prompt }
                    ],
                    response_format: { type: "json_object" }
                });
                aiResponse = JSON.parse(completion.choices[0].message.content);
            } else {
                const jsonModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash", generationConfig: { responseMimeType: "application/json" } });
                const result = await jsonModel.generateContent(prompt);
                aiResponse = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());
            }

            // 6. Save the new case to the Database
            const dbPayload = {
                client_name: facts.client_name,
                contact_info: facts.contact_info,
                issue_summary: facts.incident_description || 'Gathered via automated intake.',
                case_facts: facts,
                status: 'new'
            };

            const { data: newCase, error: dbErr } = await supabase.from('cases').insert(dbPayload).select().single();
            
            if (dbErr) throw new Error("Database save failed: " + dbErr.message);

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    pitch: aiResponse.pitch, 
                    legal_reasoning: aiResponse.legal_reasoning,
                    caseId: newCase.id 
                })
            };
        }

        // ==========================================
        // ACTION 2: CLOSE THE CASE (User clicked Yes/No)
        // ==========================================
        if (action === "close") {
            const { caseId, wants_letter } = body;
            
            // 1. Update the database with their final decision
            const updatePayload = {
                updated_at: new Date().toISOString()
            };

            if (wants_letter) {
                updatePayload.status = 'requires_attorney';
                updatePayload.letter_status = 'needs_drafting';
            }

            // Fetch existing facts so we can inject the wants_letter boolean safely
            const { data: existingCase } = await supabase.from('cases').select('case_facts').eq('id', caseId).single();
            if (existingCase && existingCase.case_facts) {
                updatePayload.case_facts = { ...existingCase.case_facts, wants_letter: wants_letter };
            }

            await supabase.from('cases').update(updatePayload).eq('id', caseId);

            // 2. Return the final message
            let closingMsg = wants_letter 
                ? "Excellent. I have officially sent your file to our legal team! They will review the details and email you a secure payment link as soon as your letter is ready to be dispatched. We've got your back!" 
                : "No problem at all! I have saved your file. If you change your mind and decide you want to take action, just reach out to us again. Wishing you the best of luck!";

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ closing_message: closingMsg })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };

    } catch (error) {
        console.error("Server Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
