const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { question, history, caseId } = JSON.parse(event.body);
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Question required' }) };

    // Initialize Models
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const jsonModel = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash", 
        generationConfig: { responseMimeType: "application/json" } 
    });
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });

    // ---------------------------------------------------------
    // PHASE 1: SEARCH & RETRIEVAL (The Legal Brain)
    // ---------------------------------------------------------
    
    let standaloneQuestion = question;
    if (history && history.length > 0) {
        const historyText = history.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n");
        const rewriteResult = await model.generateContent(`
            Rewrite this "New User Question" into a standalone sentence using the "Chat History" for context.
            New User Question: "${question}"
            Chat History: ${historyText}
        `);
        standaloneQuestion = rewriteResult.response.text().trim();
    }

    const embeddingResult = await embeddingModel.embedContent(standaloneQuestion);
    const vector = embeddingResult.embedding.values;
    
    const { data: chunks, error: searchError } = await supabase.rpc('hybrid_search', {
      query_text: standaloneQuestion,
      query_embedding: vector,
      match_count: 10,
      full_text_weight: 1.0, 
      semantic_weight: 2.0, 
      rrf_k: 50
    });

    if (searchError) throw new Error(`Database Error: ${searchError.message}`);
    const contextText = chunks.map(c => `SOURCE (ID: ${c.id}):\n${c.content}`).join("\n\n---\n\n");

    // ---------------------------------------------------------
    // PHASE 2: CASE ANALYST (Structured Data Extraction)
    // ---------------------------------------------------------

    const historyForExtraction = [...(history || []), { role: 'user', content: question }];
    
    // We force the AI to fill out this specific checklist.
    const extractionPrompt = `
    Analyze this chat history. Extract the following MANDATORY screening fields for a Labour Law case.
    If the user has not provided the information yet, set the value strictly to null.
    
    Chat History:
    ${JSON.stringify(historyForExtraction)}

    Return ONLY a JSON object with exactly this structure:
    {
      "client_name": null,
      "contact_info": null,
      "employer_name": null,
      "incident_date": null,
      "incident_description": null,
      "hearing_held": null,
      "case_merit_assessed": false
    }
    `;

    const extractionResult = await jsonModel.generateContent(extractionPrompt);
    const caseFacts = JSON.parse(extractionResult.response.text());

    // 4. Upsert Case to Supabase
    let activeCaseId = caseId;
    
    const dbPayload = {
        updated_at: new Date().toISOString(),
        issue_summary: caseFacts.incident_description || 'Gathering facts...',
        case_facts: caseFacts,
        ...(caseFacts.client_name && { client_name: caseFacts.client_name }),
        ...(caseFacts.contact_info && { contact_info: caseFacts.contact_info }),
    };

    if (activeCaseId) {
        await supabase.table('cases').update(dbPayload).eq('id', activeCaseId);
    } else {
        const { data: newCase } = await supabase.table('cases').insert(dbPayload).select().single();
        activeCaseId = newCase.id;
    }

    // ---------------------------------------------------------
    // PHASE 3: THE INTAKE AGENT (Generation)
    // ---------------------------------------------------------

    // We figure out which questions are still missing
    const missingFields = Object.keys(caseFacts).filter(key => caseFacts[key] === null && key !== 'case_merit_assessed');

    const finalPrompt = `
    You are Justine, a Senior Labour Law Conversion Agent.
    
    YOUR CURRENT STAGE IN THE PROCESS:
    ${missingFields.length > 0 ? "STAGE 1: INTAKE CHECKLIST" : "STAGE 2: MERIT ASSESSMENT & PITCH"}

    CURRENT CASE FACTS:
    ${JSON.stringify(caseFacts, null, 2)}

    MISSING FIELDS TO COLLECT:
    ${JSON.stringify(missingFields)}

    LEGAL CONTEXT (For reference):
    ${contextText}

    USER QUERY:
    ${question}

    INSTRUCTIONS FOR STAGE 1 (If you are in STAGE 1):
    1. You MUST gather the missing fields one by one. DO NOT give final legal advice yet.
    2. Politely and naturally ask the user for the FIRST missing field on the list.
    3. Example: If "employer_name" is missing, say "To help me look into this, could you tell me the name of the company you work for?"
    4. Keep the conversation flowing naturally, acknowledge what they just said, but steer them to the next question.

    INSTRUCTIONS FOR STAGE 2 (If you are in STAGE 2 - All facts collected):
    1. Evaluate their situation using the LEGAL CONTEXT. Does their case have merit? (e.g., was it an unfair dismissal?).
    2. Explain your findings briefly and simply.
    3. **THE PITCH:** Tell them that based on the merits, you highly recommend sending a formal "Without Prejudice" letter to the employer to demand a settlement or rectify the issue.
    4. Inform them that you can draft this letter for them right now. Once drafted, one of our human attorneys will review, sign, and send it for a fixed fee. Ask if they would like you to generate the draft.

    OUTPUT FORMAT (Return JSON):
    {
      "conversation": "Your conversational response (asking a question OR giving the pitch).",
      "legal_reasoning": "Markdown note. In Stage 1: Document what you are asking and why. In Stage 2: Document the legal merits of the case based on the Acts."
    }
    `;

    const result = await jsonModel.generateContent(finalPrompt);
    const responseJson = JSON.parse(result.response.text());

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
          ...responseJson,
          caseId: activeCaseId 
      })
    };

  } catch (error) {
    console.error("Server Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
