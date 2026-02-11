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

    // 1. Setup Models
    // Gemini 2.0 Flash for logic (it's faster and smarter at reasoning)
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const jsonModel = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash", 
        generationConfig: { responseMimeType: "application/json" } 
    });
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });

    let standaloneQuestion = question;

    // --- STEP 1: CONTEXTUALIZATION (Memory) ---
    // Rewrite the user's question based on history to ensure we search for the right thing.
    if (history && history.length > 0) {
        const historyText = history.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n");
        const rewritePrompt = `
        Rewrite the "New User Question" to be a standalone sentence that incorporates context from the "Chat History".
        Resolve references like "he", "it", "the letter".
        
        Chat History:
        ${historyText}
        
        New User Question: "${question}"
        
        Rewritten Question:
        `;
        const rewriteResult = await model.generateContent(rewritePrompt);
        standaloneQuestion = rewriteResult.response.text().trim();
    }

    // --- STEP 2: SEARCH INTENT & EXPANSION ---
    const expansionPrompt = `
      You are a legal expert. Convert the query "${standaloneQuestion}" into 3 specific South African Labour Law search terms.
      Examples: "BCEA Section 10", "Schedule 8 Code of Good Practice", "LRA Unfair Dismissal".
      Output ONLY the terms.
    `;
    const expansionResult = await model.generateContent(expansionPrompt);
    const legalKeywords = expansionResult.response.text();
    const combinedSearchQuery = `${standaloneQuestion} ${legalKeywords}`;

    // --- STEP 3: HYBRID SEARCH ---
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

    // --- STEP 4: INVESTIGATIVE ANSWER GENERATION ---
    const finalPrompt = `
    You are a Senior Labour Law Consultant conducting an intake interview.
    
    GOAL:
    Guide the user to a solution. To do this, you usually need to gather specific facts first.
    Do not be passive. Be proactive and investigative.

    CONTEXT (Legal Documents):
    ${contextText}

    CONVERSATION HISTORY:
    ${JSON.stringify(history || [])}

    CURRENT USER QUERY:
    ${question} (Contextualized: ${standaloneQuestion})

    INSTRUCTIONS:
    Return a JSON object with exactly these two fields:

    1. "conversation":
       - **ACT AS AN INVESTIGATOR.**
       - If the user's query lacks specific details (e.g., "I was fired"), DO NOT just give a generic definition of dismissal.
       - **IMMEDIATELY ASK** 1 or 2 relevant clarifying questions based on the law (e.g., "Were you given a notice to attend a hearing?", "Do you have a written contract?", "How many employees are at the company?").
       - Only provide the final legal conclusion if you have enough facts.
       - Keep the tone professional but direct. Max 3 sentences.

    2. "legal_reasoning":
       - **SHOW YOUR WORK.**
       - If you asked questions in the conversation, explain *why* those facts are legally important here. (e.g., "I am asking about the contract because BCEA Section 37 determines notice periods based on length of service.")
       - Cite specific Acts/Sections from the CONTEXT that triggered your questions.
       - Use markdown bullet points.
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
