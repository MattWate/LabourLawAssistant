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

            // 4. Create the Evaluation Prompt (Actual Merit Assessment)
            const prompt = `
            You are Justine, a highly knowledgeable South African Labour Law Assistant. 
            Review these collected facts and the legal context, then return a JSON object evaluating the case.
            
            FACTS:
            ${JSON.stringify(facts, null, 2)}
            
            LEGAL CONTEXT:
            ${contextText}
            
            CRITICAL DEFINITION OF "MERIT":
            - "High/Medium Merit" means the EMPLOYEE (the user) has a strong claim because the employer acted unfairly (e.g., no disciplinary hearing was held, or the reason for dismissal was too harsh for the offense, like being late once).
            - "Low Merit" means the employer likely acted fairly and lawfully, and the employee does not have a strong claim.

            INSTRUCTIONS:
            1. Assess the merits of the case for the EMPLOYEE based on the definition above.
            2. If the case has High/Medium merit, write a 'pitch' validating their experience, telling them the law is on their side, and offering to draft a Demand Letter for a small fixed fee. End by asking: "Would you like our legal team to draft this letter for you?"
            3. If the case has Low merit (NO merit), write a 'pitch' politely explaining why the law might not support them based on the context. Do NOT offer the demand letter, and DO NOT ask any questions at the end (e.g., do not ask "Would you like us to review it?"), because the chat interface will only provide an "Okay, thank you" button to close the conversation.
            
            RETURN ONLY A JSON OBJECT WITH THIS EXACT STRUCTURE:
            {
              "merit_assessment": "High", "Medium", or "Low",
              "legal_reasoning": "Markdown bullet points explaining your assessment.",
              "pitch": "Your warm, conversational response to the user."
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

            // Force standard formatting of facts so the Admin panel ALWAYS sees them
            const coreFacts = {
                client_name: facts.client_name || null,
                contact_info: facts.contact_info || null,
                employer_name: facts.employer_name || null,
                employer_contact_details: facts.employer_contact_details || null,
                incident_date: facts.incident_date || null,
                incident_description: facts.incident_description || null,
                hearing_held: facts.hearing_held !== undefined ? facts.hearing_held : null,
                employment_status: facts.employment_status || null,
                sector: facts.sector || null,
                tenure: facts.tenure || null,
                wants_letter: null, // Always initialize so it shows in Admin dropdowns
                merit_assessment: aiResponse.merit_assessment || 'Unknown',
                legal_reasoning: aiResponse.legal_reasoning || 'No reasoning provided.'
            };

            // 6. Save the new case to the Database
            const dbPayload = {
                client_name: facts.client_name,
                contact_info: facts.contact_info,
                issue_summary: facts.incident_description || 'Gathered via automated intake.',
                case_facts: coreFacts,
                status: 'new'
            };

            const { data: newCase, error: dbErr } = await supabase.from('cases').insert(dbPayload).select().single();
            
            if (dbErr) throw new Error("Database save failed: " + dbErr.message);

            const hasMerit = aiResponse.merit_assessment !== "Low";

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    pitch: aiResponse.pitch, 
                    hasMerit: hasMerit,
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
                : "No problem at all! I have saved your file. If you change your mind, just reach out to us again. Wishing you the best of luck!";

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
