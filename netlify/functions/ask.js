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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { question, history, caseId } = JSON.parse(event.body);
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Question required' }) };

    // Initialize Gemini Models (used for DB search)
    const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const jsonModel = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash", 
        generationConfig: { responseMimeType: "application/json" } 
    });
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });

    // ---------------------------------------------------------
    // PHASE 1: SEARCH & RETRIEVAL (The Legal Brain)
    // ---------------------------------------------------------
    
    // 1. Contextualize the question using chat history
    let standaloneQuestion = question;
    if (history && history.length > 0) {
        const historyText = history.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n");
        const rewriteResult = await geminiModel.generateContent(`
            Rewrite this "New User Question" into a standalone sentence using the "Chat History" for context.
            New User Question: "${question}"
            Chat History: ${historyText}
        `);
        standaloneQuestion = rewriteResult.response.text().trim();
    }

    // 2. Embed the question and search Supabase
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
    // PHASE 2 & 3: COMBINED EXTRACTION, PERSONA & GENERATION
    // ---------------------------------------------------------
    
    let activeCaseId = caseId;
    let currentCaseFacts = {
      client_name: null, contact_info: null, employer_name: null, employer_contact_details: null,
      incident_date: null, incident_description: null, hearing_held: null, wants_letter: false
    };

    // If we have an active case, fetch the existing facts so the AI knows where we left off
    if (activeCaseId) {
        const { data: existingCase } = await supabase.from('cases').select('case_facts').eq('id', activeCaseId).single();
        if (existingCase && existingCase.case_facts) {
            currentCaseFacts = { ...currentCaseFacts, ...existingCase.case_facts };
        }
    }

    // Check which LLM the Admin wants to use for the conversation
    const { data: settingData } = await supabase.from('system_settings').select('setting_value').eq('setting_name', 'active_llm').single();
    const activeLLM = settingData ? settingData.setting_value : 'gemini';

    const combinedPrompt = `
    You are Justine, a friendly, empathetic, and highly knowledgeable Labour Law Assistant.
    Your main clients are everyday South African workers (e.g., factory workers, retail staff, drivers, miners). 
    You MUST speak in plain, simple, everyday English. Do not use heavy legal jargon in the conversation. 
    Be warm, supportive, and talk to them like a helpful friend who knows the law. 
    Keep your sentences relatively short and easy to understand.

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
    2. STRICT STAGE DETERMINATION & RESPOND (Write the "conversation" field):
       - STEP A: Look at your newly updated facts. Are there ANY fields (except wants_letter) that are still null?
       - STAGE 1 (Intake - if ANY fact is still null): You MUST ask the user for the FIRST missing fact. Do this naturally and warmly. Acknowledge what they said and show sympathy. You are STRICTLY FORBIDDEN from pitching the letter or drafting the letter until every single fact (name, contact info, employer name, employer contact, date, description, hearing) is provided.
       - STAGE 2 (Pitch - if ALL facts are provided BUT wants_letter is false): Look at the LEGAL CONTEXT. Tell them simply if the law is on their side. Then, offer to help: tell them you can draft a formal, strong demand letter to the employer to fix the issue or ask for a settlement. Explain that our legal team will check and send it for a small fixed fee, and ask if they want you to write it for them now.
       - STAGE 3 (Closing - if ALL facts are provided AND wants_letter is true): Reassure the user. Tell them you have successfully sent their file to our legal team. The team will review everything, draft the formal letter, and send them an email with a payment link when it's ready. Do NOT draft the letter yourself.

    Return ONLY a JSON object with this exact structure:
    {
      "updated_facts": {
        "client_name": "...",
        "contact_info": "...",
        "employer_name": "...",
        "employer_contact_details": "...",
        "incident_date": "...",
        "incident_description": "...",
        "hearing_held": "...",
        "wants_letter": true/false
      },
      "conversation": "Your warm, simple, conversational response.",
      "legal_reasoning": "Markdown notes detailing merits or reasoning."
    }
    `;

    let responseJson = null;

    // AI ROUTER: Route to the requested AI Model
    if (activeLLM === 'openai' && openai) {
        // Use ChatGPT
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are a legal JSON processor. Always return strictly formatted JSON." },
                { role: "user", content: combinedPrompt }
            ],
            response_format: { type: "json_object" }
        });
        responseJson = JSON.parse(completion.choices[0].message.content);
    } else {
        // Use Gemini
        const result = await jsonModel.generateContent(combinedPrompt);
        let rawText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        responseJson = JSON.parse(rawText);
    }

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

    // Determine letter status: Tag it so the Admin knows it needs to be drafted
    if (newFacts.wants_letter) {
        dbPayload.letter_status = 'needs_drafting';
        dbPayload.status = 'requires_attorney';
    }

    // Save
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
