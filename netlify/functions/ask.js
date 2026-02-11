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
    const { question, history } = JSON.parse(event.body);
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Question required' }) };

    // Use Gemini 2.0 Flash for logic/chat
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const jsonModel = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash", 
        generationConfig: { responseMimeType: "application/json" } 
    });
    // Use Embedding 001 for vector search
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });

    let standaloneQuestion = question;

    // --- STEP 1: CONTEXTUALIZATION (The "Memory" Fix) ---
    // If there is history, we must rewrite the user's question to be self-contained.
    if (history && history.length > 0) {
        const historyText = history.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n");
        
        const rewritePrompt = `
        Given the following conversation history and a new user question, rewrite the new question to be a standalone sentence that includes all necessary context from the history.
        
        Chat History:
        ${historyText}
        
        New User Question: "${question}"
        
        Directives:
        1. Resolve references like "he", "it", "that" to the specific nouns mentioned earlier.
        2. Keep the core intent of the question.
        3. If the question is already standalone, return it as is.
        
        Rewritten Question:
        `;
        
        const rewriteResult = await model.generateContent(rewritePrompt);
        standaloneQuestion = rewriteResult.response.text().trim();
        console.log("Original:", question);
        console.log("Rewritten:", standaloneQuestion);
    }

    // --- STEP 2: QUERY EXPANSION ---
    // Use the REWRITTEN question to generate search terms
    const expansionPrompt = `
      You are a legal research assistant. 
      Convert the following specific query into 3 specific legal search terms for South African Labour Law.
      Output specific Act names or legal concepts (e.g. "BCEA Section 10", "Automatic Unfair Dismissal").
      
      Query: "${standaloneQuestion}"
      
      Output just the terms.
    `;
    const expansionResult = await model.generateContent(expansionPrompt);
    const legalKeywords = expansionResult.response.text();
    
    // Combine for a rich search query
    const combinedSearchQuery = `${standaloneQuestion} ${legalKeywords}`;

    // --- STEP 3: SEARCH ---
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

    // --- STEP 4: ANSWER GENERATION ---
    const finalPrompt = `
    You are a Labour Law Assistant. You have two goals: 
    1. Have a natural, human conversation with the client.
    2. Provide a technical legal breakdown for their records.

    CONTEXT (Legal Documents):
    ${contextText}

    CONVERSATION HISTORY:
    ${JSON.stringify(history || [])}

    CURRENT USER QUERY:
    ${question} (Contextualized as: ${standaloneQuestion})

    INSTRUCTIONS:
    Return a JSON object with exactly these two fields:
    
    1. "conversation": 
       - A friendly, short response (2-3 sentences max). 
       - Acknowledge facts mentioned earlier in the history (e.g., "Since you mentioned you work on Saturdays...").
       - Use simple, layperson English.

    2. "legal_reasoning":
       - A structured, technical note.
       - Cite specific Acts, Sections, or Schedules found in the CONTEXT.
       - Explain *why* the law applies to the user's specific story facts.
       - Format this as a markdown string (use bullet points).
    `;

    const result = await jsonModel.generateContent(finalPrompt);
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
