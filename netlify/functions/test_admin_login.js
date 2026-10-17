const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function stagingOnly() {
  const context = String(process.env.CONTEXT || '').toLowerCase();
  const branch = String(process.env.BRANCH || process.env.HEAD || '').toLowerCase();
  return context !== 'production' && branch !== 'main';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!stagingOnly()) return json(404, { error: 'Not Found' });

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase auth is not configured');
    const { email, password } = JSON.parse(event.body || '{}');
    if (!email || !password) return json(400, { error: 'Email and password are required' });

    const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data?.session?.access_token) {
      return json(401, { error: error?.message || 'Sign-in failed' });
    }

    return json(200, {
      success: true,
      access_token: data.session.access_token,
      expires_at: data.session.expires_at || null,
      user: {
        id: data.user?.id || null,
        email: data.user?.email || null
      }
    });
  } catch (error) {
    return json(500, { error: String(error.message || error) });
  }
};
