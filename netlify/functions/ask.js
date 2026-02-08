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
    const { question } = JSON.parse(event.body);
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Question required' }) };

    // Initialize Models
    // We use the same model for both "Thinking" and "Answering"
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });

    // --- STEP 1: QUERY EXPANSION (The "Translation" Layer) ---
    // We ask Gemini to convert the user's "Story" into "Legal Keywords"
    const expansionPrompt = `
      You are a legal research assistant. 
      Convert the following user query (which may be a story or scenario) into 5 specific legal search terms or concepts relevant to South African Labour Law.
      Do not answer the question. Just output the keywords.
      
      User Query: "${question}"
      
      Keywords:
    `;
    
    const expansionResult = await model.generateContent(expansionPrompt);
    const legalKeywords = expansionResult.response.text();
    
    console.log(`User Story: "${question}"`);
    console.log(`Generated Search Terms: "${legalKeywords}"`);

    // Combine original question + legal keywords for a powerful "Hybrid" search query
    const combinedSearchQuery = `${question} ${legalKeywords}`;

    // --- STEP 2: EMBEDDING & SEARCH ---
    const embeddingResult = await embeddingModel.embedContent(combinedSearchQuery);
    const vector = embeddingResult.embedding.values;

    const { data: chunks, error: searchError } = await supabase.rpc('hybrid_search', {
      query_text: combinedSearchQuery, // Use the expanded query for keyword match
      query_embedding: vector,         // Use the expanded vector for semantic match
      match_count: 15,                 
      full_text_weight: 1.0, 
      semantic_weight: 2.0, 
      rrf_k: 50
    });

    if (searchError) throw new Error(`Database Error: ${searchError.message}`);

    const contextText = chunks
      .map(chunk => `SOURCE (ID: ${chunk.id}):\n${chunk.content}`)
      .join("\n\n---\n\n");

    // --- STEP 3: ANSWER GENERATION (The "Advisor") ---
    const finalPrompt = `
    You are a professional legal assistant for South African labor law.
    
    CONTEXT:
    ${contextText}

    USER QUERY:
    ${question}

    INSTRUCTIONS:
    1. **Analyze the Scenario:** Look for legal concepts in the context that apply to the user's story (e.g., if they mention "swearing", look for "misconduct" or "insubordination" in the context).
    2. **Strict Grounding:** Base your advice ONLY on the provided context acts and codes.
    3. **Handle Gaps:** - If the exact answer is in the text, give it.
       - If the *exact* answer is missing, but the context contains the *general procedure* (like Schedule 8 Code of Good Practice), explain that general procedure.
       - **CRITICAL:** If you need more details to give a specific answer (e.g., "Is there a contract?", "Was there a hearing?"), **ASK THE USER** these questions at the end of your response to clarify the situation.
    4. **Tone:** Professional, empathetic, but legally cautious. Do not give binding legal advice, give "guidance based on the Act".
    5. **Output:** Clean text, use bullet points. Do NOT mention "Source IDs".
    `;

    const result = await model.generateContent(finalPrompt);
    const answer = result.response.text();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer, sources: chunks })
    };

  } catch (error) {
    console.error("Server Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
