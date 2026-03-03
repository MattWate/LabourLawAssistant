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
    // PHASE 2 & 3: COMBINED EXTRACTION & GENERATION
    // ---------------------------------------------------------
    
    let activeCaseId = caseId;
    let currentCaseFacts = {
      client_name: null, contact_info: null, employer_name: null,
      incident_date: null, incident_description: null, hearing_held: null, wants_letter: false
    };

    // If we have an active case, fetch the existing facts first so Gemini knows where we left off
    if (activeCaseId) {
        const { data: existingCase } = await supabase.from('cases').select('case_facts').eq('id', activeCaseId).single();
        if (existingCase && existingCase.case_facts) {
            currentCaseFacts = { ...currentCaseFacts, ...existingCase.case_facts };
        }
    }

    const combinedPrompt = `
    You are Justine, a Senior Labour Law Conversion Agent.
    
    CURRENT CASE FACTS:
    ${JSON.stringify(currentCaseFacts, null, 2)}

    CHAT HISTORY:
    ${JSON.stringify(history)}

    NEW USER QUERY:
    ${question}

    LEGAL CONTEXT (For reference):
    ${contextText}

    YOUR TASKS:
    1. EXTRACT: Update the CURRENT CASE FACTS based on the NEW USER QUERY. If they provided a missing detail, update the null value. If they agreed to a letter, set "wants_letter" to true.
    2. DETERMINE STAGE & RESPOND:
       - STAGE 1 (Intake): If any fact (except wants_letter) is null, ask the user for the FIRST missing fact naturally and politely.
       - STAGE 2 (Pitch): If all facts are gathered but wants_letter is false, evaluate their case using the LEGAL CONTEXT. Briefly explain the merits and pitch our "Without Prejudice" letter service. Ask if they want you to draft it.
       - STAGE 3 (Draft): If wants_letter is true, tell the user the letter is drafted and with the legal team. Draft the actual formal letter in the JSON response.

    Return ONLY a JSON object with this exact structure:
    {
      "updated_facts": {
        "client_name": "...",
        "contact_info": "...",
        "employer_name": "...",
        "incident_date": "...",
        "incident_description": "...",
        "hearing_held": "...",
        "wants_letter": true/false
      },
      "conversation": "Your conversational response for Stage 1, 2, or 3.",
      "legal_reasoning": "Markdown notes detailing merits or reasoning.",
      "draft_letter": null // ONLY populate this string with the formal letter text if you are in STAGE 3.
    }
    `;

    const result = await jsonModel.generateContent(combinedPrompt);
    const responseJson = JSON.parse(result.response.text());
    const newFacts = responseJson.updated_facts;

    // ---------------------------------------------------------
    // PHASE 4: SAVE TO SUPABASE
    // ---------------------------------------------------------
    
    const dbPayload = {
        updated_at: new Date().toISOString(),
        issue_summary: newFacts.incident_description || 'Gathering facts...',
        case_facts: newFacts,
        ...(newFacts.client_name && { client_name: newFacts.client_name }),
        ...(newFacts.contact_info && { contact_info: newFacts.contact_info }),
    };

    // Determine letter status
    if (responseJson.draft_letter) {
        dbPayload.draft_letter = responseJson.draft_letter;
        dbPayload.letter_status = 'pending_review';
        dbPayload.status = 'requires_attorney';
    }

    if (activeCaseId) {
        await supabase.from('cases').update(dbPayload).eq('id', activeCaseId);
    } else {
        const { data: newCase } = await supabase.from('cases').insert(dbPayload).select().single();
        activeCaseId = newCase.id;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
          conversation: responseJson.conversation,
          legal_reasoning: responseJson.legal_reasoning,
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
