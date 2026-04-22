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
            
            // 1. DYNAMICALLY Build legal keywords based on the user's specific path
            let legalKeywords = "labour law South Africa";
            
            if (facts.employment_status === "Dismissed") {
                legalKeywords += " unfair dismissal";
                if (facts.dismissal_reason_type === "Misconduct") legalKeywords += " misconduct schedule 8";
                if (facts.dismissal_reason_type === "Poor Performance") legalKeywords += " incapacity poor work performance schedule 8";
                if (facts.dismissal_reason_type === "Incapacity") legalKeywords += " incapacity ill health injury items 10 11";
                if (facts.dismissal_reason_type === "Retrenchment") legalKeywords += " operational requirements retrenchment section 189";
            } else if (facts.employment_status === "Resigned") {
                legalKeywords += " constructive dismissal intolerable working conditions section 186(1)(e)";
            } else if (facts.employment_status === "Employed") {
                legalKeywords += " unfair labour practice";
            } else if (facts.employment_status === "Discrimination") {
                legalKeywords += " employment equity automatically unfair discrimination harassment section 187";
            } else if (facts.employment_status === "Advisory") {
                legalKeywords += " BCEA grievance disciplinary hearing procedures";
            }

            // Add modifiers based on binary questions
            if (facts.hearing_held === false || facts.proc_notice === "none") legalKeywords += " procedural fairness no hearing";
            if (facts.proc_notice === false) legalKeywords += " no 48 hours notice";
            if (facts.proc_rep === false) legalKeywords += " denied representation";
            if (facts.proc_chair === false) legalKeywords += " biased chairperson";
            if (facts.proc_consultation === false) legalKeywords += " failure to consult alternatives";
            if (facts.paid_suspension === false) legalKeywords += " unpaid suspension section 186(2)(b)";
            if (facts.contract_type === "Contractor") legalKeywords += " independent contractor jurisdiction";
            
            // Final, highly targeted search query
            const searchQuery = `${facts.incident_description || ''} ${facts.sector || ''} ${legalKeywords}`;
            
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

            // 4. Create the Evaluation Prompt (Strict 1-10 Rubric)
            const prompt = `
            You are Justine, a highly knowledgeable South African Labour Law Assistant. 
            Review these collected facts and the legal context, then return a strictly formatted JSON scorecard.
            
            FACTS:
            ${JSON.stringify(facts, null, 2)}
            
            LEGAL CONTEXT:
            ${contextText}
            
            INSTRUCTIONS & RUBRIC:
            You must independently score this case out of 10 for both Substantive Fairness (the "Why") and Procedural Fairness (the "How").

            1. SUBSTANTIVE FAIRNESS RUBRIC (1-10):
            - 1 to 3 (Employer Favored): Employee admits to gross misconduct (theft, assault, fraud) or voluntary resignation without duress.
            - 4 to 6 (Moderate/Gray Area): Minor offense (late, poor performance), but penalty might be too harsh.
            - 7 to 9 (Employee Favored): Trivial reason given for dismissal/warning, unsubstantiated, or disproportionate.
            - 10 (Automatic Unfairness): Protected grounds (discrimination, pregnancy) or completely baseless.
            *Note: If Constructive Dismissal or ULP, adapt scale logically (10 = blatant employer abuse).*

            2. PROCEDURAL FAIRNESS RUBRIC (1-10):
            - 1 to 3 (Perfect Procedure): Proper hearing, 48h notice given, rep allowed, independent chair.
            - 4 to 6 (Flawed Procedure): Hearing held, but corners cut (e.g., no rep allowed, biased chair, poor consultation for incapacity).
            - 7 to 10 (Zero Procedure): Fired on the spot, fired via text, no hearing at all, or unpaid suspension without hearing.

            3. PITCH TO CLIENT:
            - If Substantive Score >= 6 OR Procedural Score >= 6: Write a conversational pitch validating their experience. State their scores briefly, explain the leverage (e.g. "Even if they had a reason to fire you, the way they did it was unlawful"), and ask: "Would you like our legal team to review your file and draft a Without Prejudice demand letter to open negotiations?"
            - If Substantive Score < 6 AND Procedural Score < 6: Write a polite response explaining why the law favors the employer here. Do NOT offer the demand letter.

            RETURN ONLY A JSON OBJECT WITH THIS EXACT STRUCTURE:
            {
              "substantive_score": number (1 to 10),
              "procedural_score": number (1 to 10),
              "overall_viability": "Short summary of leverage, e.g., 'Strong procedural leverage for settlement'",
              "strengths": ["bullet point 1", "bullet point 2"],
              "weaknesses": ["bullet point 1"],
              "attorney_review_flag": boolean,
              "pitch_to_client": "Your conversational response to the user."
            }
            `;

            let aiResponse = null;

            // 5. Ask the chosen LLM to evaluate and generate the scorecard
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
                employment_status: facts.employment_status || null,
                dismissal_reason_type: facts.dismissal_reason_type || null,
                hearing_held: facts.hearing_held !== undefined ? facts.hearing_held : null,
                proc_notice: facts.proc_notice !== undefined ? facts.proc_notice : null,
                proc_rep: facts.proc_rep !== undefined ? facts.proc_rep : null,
                proc_chair: facts.proc_chair !== undefined ? facts.proc_chair : null,
                proc_consultation: facts.proc_consultation !== undefined ? facts.proc_consultation : null,
                paid_suspension: facts.paid_suspension !== undefined ? facts.paid_suspension : null,
                constructive_dismissal: facts.constructive_dismissal !== undefined ? facts.constructive_dismissal : null,
                sector: facts.sector || null,
                contract_type: facts.contract_type || null,
                wants_letter: null,
                
                // AI Scorecard Data
                substantive_score: aiResponse.substantive_score || 0,
                procedural_score: aiResponse.procedural_score || 0,
                overall_viability: aiResponse.overall_viability || 'Unknown',
                strengths: aiResponse.strengths || [],
                weaknesses: aiResponse.weaknesses || [],
                attorney_review_flag: aiResponse.attorney_review_flag || false
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

            // A case has merit if EITHER substantive OR procedural is 6 or higher
            const hasMerit = (aiResponse.substantive_score >= 6 || aiResponse.procedural_score >= 6);

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    pitch: aiResponse.pitch_to_client, 
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
