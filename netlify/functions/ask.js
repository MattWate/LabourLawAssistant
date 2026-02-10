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
    const { question, history } = JSON.parse(event.body); // Accepted history if you want to add it later
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Question required' }) };

    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash", 
        generationConfig: { responseMimeType: "application/json" } // Force JSON output
    });
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });

    // --- STEP 1: QUERY EXPANSION ---
    const expansionPrompt = `
      You are a legal research assistant. 
      Convert the user query into 3 specific legal search terms for South African Labour Law.
      Output specific Act names or legal concepts (e.g. "BCEA Section 10", "Automatic Unfair Dismissal").
      User Query: "${question}"
      Output just the terms.
    `;
    const expansionResult = await model.generateContent(expansionPrompt);
    const legalKeywords = expansionResult.response.text();
    const combinedSearchQuery = `${question} ${legalKeywords}`;

    // --- STEP 2: SEARCH ---
    const embeddingResult = await embeddingModel.embedContent(combinedSearchQuery);
    const vector = embeddingResult.embedding.values;

    const { data: chunks, error: searchError } = await supabase.rpc('hybrid_search', {
      query_text: combinedSearchQuery,
      query_embedding: vector,
      match_count: 10,
      full_text_weight: 1.0, 
      semantic_weight: 2.0, 
      rrf_k: 50
    });

    if (searchError) throw new Error(`Database Error: ${searchError.message}`);

    const contextText = chunks
      .map(chunk => `SOURCE (ID: ${chunk.id}):\n${chunk.content}`)
      .join("\n\n---\n\n");

    // --- STEP 3: DUAL-MODE ANSWER GENERATION ---
    const finalPrompt = `
    You are a Labour Law Assistant. You have two goals: 
    1. Have a natural, human conversation with the client.
    2. Provide a technical legal breakdown for their records.

    CONTEXT:
    ${contextText}

    USER QUERY:
    ${question}

    INSTRUCTIONS:
    Return a JSON object with exactly these two fields:
    
    1. "conversation": 
       - A friendly, short response (2-3 sentences max). 
       - Do NOT give a massive lecture. 
       - If you need more info (e.g. "Is there a contract?"), ask the user specifically.
       - Use simple, layperson English.

    2. "legal_reasoning":
       - A structured, technical note.
       - Cite specific Acts, Sections, or Schedules found in the CONTEXT.
       - Quote the relevant line from the act if possible.
       - Explain *why* the law applies here.
       - Format this as a markdown string (use bullet points).
    `;

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();
    const jsonResponse = JSON.parse(responseText);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonResponse)
    };

  } catch (error) {
    console.error("Server Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
