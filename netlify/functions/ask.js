const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { question } = JSON.parse(event.body);
    
    if (!question) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Question is required' }) };
    }

    // 1. Generate Embedding for the Question
    // We use the exact same model as ingest.py to match dimensions
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    
    // SDK Update: use embedContent and access values correctly
    const embeddingResult = await embeddingModel.embedContent(question);
    const vector = embeddingResult.embedding.values;

    // 2. Hybrid Search in Supabase
    // We call the 'hybrid_search' RPC function created in SQL
    const { data: chunks, error: searchError } = await supabase.rpc('hybrid_search', {
      query_text: question,
      query_embedding: vector,
      match_count: 15,       // UPDATED: Increased to 15 chunks for broader context
      full_text_weight: 1.0, 
      semantic_weight: 2.0, // Prioritize meaning over keywords
      rrf_k: 50
    });

    if (searchError) {
      console.error("Supabase Error:", searchError);
      throw new Error(`Database Error: ${searchError.message}`);
    }

    // 3. Construct the Context String
    const contextText = chunks
      .map(chunk => `SOURCE (ID: ${chunk.id}):\n${chunk.content}`)
      .join("\n\n---\n\n");

    // 4. Generate Answer with Gemini 2.0 Flash
    const chatModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    // UPDATED PROMPT: Stricter "Docs Only" rules and cleaner formatting
    const prompt = `
    You are a professional legal assistant for South African labor law. 
    Your knowledge base is STRICTLY LIMITED to the provided context below.

    Directives:
    1. **Strict Grounding:** Answer the user's question using ONLY the information found in the 'Context' section below. Do not use your own outside knowledge.
    2. **Transparency:** If the answer is not explicitly found in the context, state: "I cannot find specific details regarding this in the uploaded documents." Do not try to make up an answer.
    3. **Professional Tone:** Provide clear, concise, and professional answers. Use bullet points for lists.
    4. **Citations:** Refer to specific Acts or Sections if available in the text (e.g., "According to the Basic Conditions of Employment Act..."). 
    5. **Clean Output:** Do NOT mention internal "Source IDs", "Chunks", or "Database Records" in your final response.

    Context:
    ${contextText}
    
    User Question: 
    ${question}
    `;

    const result = await chatModel.generateContent(prompt);
    const response = await result.response;
    const answer = response.text();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer, sources: chunks })
    };

  } catch (error) {
    console.error("Server Error:", error);
    // Send the actual error message to the frontend
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Unknown Error" })
    };
  }
};
