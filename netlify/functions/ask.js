const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
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
        const action = body.action; // Expects "classify", "evaluate" or "close"

        // ==========================================
        // ACTION 0: CLASSIFY INITIAL QUERY (The Smart Extractor)
        // ==========================================
        if (action === "classify") {
            const userText = body.text;

            // Check Admin Settings for Active LLM
            const { data: settingData } = await supabase.from('system_settings').select('setting_value').eq('setting_name', 'active_llm').single();
            const activeLLM = settingData ? settingData.setting_value : 'gemini';

            const prompt = `
            You are a South African Labour Law triage router.
            The user has provided the following initial query:
            "${userText}"

            TASK 1: CATEGORIZE
            Categorize their issue strictly into ONE of the following exact strings:
            - "Dismissed" (User was fired, retrenched, let go, or contract ended)
            - "Resigned" (User quit, forced to resign, or constructively dismissed)
            - "Discrimination" (User faces racism, sexism, harassment, or EEA issues)
            - "Advisory" (User is still employed and needs help with a warning, grievance, hearing prep, or pay issue)
            - "UIF" (User is explicitly asking about Unemployment Insurance Fund claims)

            If the user's text is too vague, short, or ambiguous, return "Ambiguous".

            TASK 2: SMART EXTRACTION
            If the user provided enough detail in their story, extract the sub-category so we don't have to ask them again. If it is NOT obvious, return null.
            - "dismissal_reason_type": Only if category is Dismissed. Choose strictly from: "Misconduct" (breaking rules, stealing, fighting), "Poor Performance" (too slow, targets missed), "Incapacity" (ill health, injury), "Retrenchment" (downsizing).
            - "advisory_topic": Only if category is Advisory. Choose strictly from: "Hearing Prep", "Warning", "Grievance", "Pay Issue".

            Return ONLY a JSON object with this exact format:
            { 
              "category": "String",
              "dismissal_reason_type": "String or null",
              "advisory_topic": "String or null"
            }
            `;

            let resultData = { category: "Ambiguous", dismissal_reason_type: null, advisory_topic: null };

            if (activeLLM === 'openai' && openai) {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "You are a routing JSON processor. Always return strictly formatted JSON." },
                        { role: "user", content: prompt }
                    ],
                    response_format: { type: "json_object" }
                });
                resultData = JSON.parse(completion.choices[0].message.content);
            } else {
                const jsonModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash", generationConfig: { responseMimeType: "application/json" } });
                const result = await jsonModel.generateContent(prompt);
                resultData = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());
            }

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(resultData)
            };
        }

        // ==========================================
        // ACTION 1: EVALUATE & PITCH (The 1-10 Rubric)
        // ==========================================
        if (action === "evaluate") {
            const facts = body.facts;
            
            // Combine their initial story with their detailed description for maximum context
            const fullStory = (facts.initial_query ? facts.initial_query + " " : "") + (facts.incident_description || "");
            
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
            const searchQuery = `${fullStory} ${facts.sector || ''} ${legalKeywords}`;
            
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

            // 4. Create the Evaluation Prompt (Strict 1-10 Rubric & Justification)
            const prompt = `
            You are Justine, a highly knowledgeable South African Labour Law Assistant. 
            Review these collected facts and the legal context, then return a strictly formatted JSON scorecard.
            
            FACTS:
            ${JSON.stringify(facts, null, 2)}
            
            LEGAL CONTEXT:
            ${contextText}
            
           INSTRUCTIONS & RUBRIC:
            You must evaluate this case strictly from the perspective of the EMPLOYEE (your client). 
            Scores are out of 10. A score of 10 means the EMPLOYEE has a massive advantage to win at the CCMA. A score of 1 means the EMPLOYER has a perfect defense.

            1. SUBSTANTIVE FAIRNESS SCORE (1-10): (How likely is the employee to win based on the reason for dismissal?)
            - 1 to 3: Employee will lose. They admitted to severe gross misconduct (theft, assault, fraud).
            - 4 to 6: Gray area. Minor offense, but employee has warnings, OR a "he-said-she-said" scenario.
            - 7 to 9: Employee will likely win. Dismissal was completely disproportionate (e.g., fired for swearing once with a 6-year clean record), unsubstantiated, or trivial.
            - 10: Automatic unfairness (Discrimination, pregnancy, etc).

            2. PROCEDURAL FAIRNESS SCORE (1-10): (How likely is the employee to win based on how the firing was handled?)
            - 1 to 3: Employee will lose procedurally. Employer held a perfect, unbiased hearing with 48h notice and representation.
            - 4 to 6: Employee has some leverage. Hearing was held, but there were minor flaws or biases.
            - 7 to 10: Employee has massive leverage. No hearing at all, same-day notice, severely biased chairperson (e.g., the manager involved chaired the hearing), or denied representation.

            3. JUSTIFICATION (STRENGTHS & WEAKNESSES):
            - "Strengths": List facts that help the EMPLOYEE win (e.g., "The employer failed to provide 48 hours notice, violating Schedule 8").
            - "Weaknesses": List facts that hurt the EMPLOYEE'S case (e.g., "The employee admitted to swearing at the supervisor, which is insubordination").

            4. PITCH TO CLIENT (TRANSPARENT FEEDBACK):
            - Explain the split to the client so they understand the merits of their own case based on the scores above.
            - Do not just say "the law is on your side." You must explain the split to the client so they understand the merits of their own case.
            - Example format: "Based on what you've told me, here is where you stand. Substantively (the reason for dismissal), your case is a [Score]/10 because [Insert Fact]. However, Procedurally (how they fired you), you have a [Score]/10 because [Insert Fact]."
            - If Substantive Score >= 6 OR Procedural Score >= 6: Conclude by offering the Without Prejudice demand letter to leverage their procedural or substantive strong points for a settlement.
            - If BOTH scores are < 6: Politely explain exactly why the law favors the employer based on their facts, and do not offer the letter.

            RETURN ONLY A JSON OBJECT WITH THIS EXACT STRUCTURE:
            {
              "substantive_score": number (1 to 10),
              "procedural_score": number (1 to 10),
              "overall_viability": "Short summary of leverage, e.g., 'Strong procedural leverage for settlement despite substantive weakness'",
              "strengths": ["Explicit reason for Procedural Score citing facts", "Explicit reason for Substantive Score citing facts"],
              "weaknesses": ["Explicit legal risks based on facts"],
              "attorney_review_flag": boolean,
              "pitch_to_client": "Your transparent, conversational response explaining the specific scores and facts to the user."
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
                incident_description: fullStory || null,
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
                issue_summary: fullStory || 'Gathered via automated intake.',
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
            
            const updatePayload = {
                updated_at: new Date().toISOString()
            };

            if (wants_letter) {
                updatePayload.status = 'requires_attorney';
                updatePayload.letter_status = 'needs_drafting';
            }

            const { data: existingCase } = await supabase.from('cases').select('case_facts').eq('id', caseId).single();
            if (existingCase && existingCase.case_facts) {
                updatePayload.case_facts = { ...existingCase.case_facts, wants_letter: wants_letter };
            }

            await supabase.from('cases').update(updatePayload).eq('id', caseId);

            let closingMsg = wants_letter 
                ? "Excellent. I have officially sent your file to our legal team! They will review the details and email you a secure payment link as soon as your letter is ready to be dispatched. We've got your back!" 
                : "No problem at all! I have saved your file. If you change your mind, just reach out to us again. Wishing you the best of luck!";

            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ closing_message: closingMsg })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ error: "Invalid action provided" }) };

    } catch (error) {
        console.error("Server Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
