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
    // MUST use the exact same model as ingest.py to match dimensions (3072 or 768)
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    const embeddingResult = await embeddingModel.embedContent(question);
    const vector = embeddingResult.embedding.values;

    // 2. Hybrid Search in Supabase
    // We call the 'hybrid_search' RPC function you created in SQL
    const { data: chunks, error: searchError } = await supabase.rpc('hybrid_search', {
      query_text: question,
      query_embedding: vector,
      match_count: 5,       // Top 5 relevant chunks
      full_text_weight: 1.0, 
      semantic_weight: 2.0, // Prioritize meaning over keywords
      rrf_k: 50
    });

    if (searchError) {
      console.error("Supabase Error:", searchError);
      throw new Error("Failed to search database.");
    }

    // 3. Construct the Context String
    const contextText = chunks
      .map(chunk => `SOURCE (${chunk.id}):\n${chunk.content}`)
      .join("\n\n---\n\n");

    // 4. Generate Answer with Gemini 2.0 Flash
    const chatModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const prompt = `
    You are a legal assistant for South African labor law. 
    Use the following context to answer the user's question.
    
    Rules:
    - Base your answer ONLY on the provided context.
    - If the answer is not in the context, say "I cannot find this in the database."
    - Cite the case names or acts if mentioned in the text.
    
    Context:
    ${contextText}
    
    User Question: 
    ${question}
    `;

    const result = await chatModel.generateContent(prompt);
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
      body: JSON.stringify({ error: "Internal Server Error", details: error.message })
    };
  }
};
