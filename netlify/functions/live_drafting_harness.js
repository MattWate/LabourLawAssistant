const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getStore } = require('@netlify/blobs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const STORE_NAME = 'justine-drafting-harness';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

async function authenticate(event) {
  if (!supabase) throw new Error('Supabase is not configured');
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('Unauthorized');
  const { data, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) throw new Error('Unauthorized');
  return data.user;
}

function siteBaseUrl(event) {
  const host = event.headers?.host || event.headers?.['x-forwarded-host'];
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  const configured = process.env.DEPLOY_PRIME_URL || process.env.URL;
  if (configured) return configured.replace(/\/$/, '');
  throw new Error('Could not determine site URL');
}

function sign(raw) {
  if (!INTERNAL_SIGNING_KEY) throw new Error('Harness signing key is not configured');
  return crypto.createHmac('sha256', INTERNAL_SIGNING_KEY).update(raw, 'utf8').digest('hex');
}

function store() {
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const user = await authenticate(event);
    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || 'start');

    if (action === 'status') {
      const jobId = String(body.jobId || '');
      if (!jobId) return json(400, { error: 'jobId required' });
      const data = await store().get(jobId, { type: 'json', consistency: 'strong' });
      if (!data) return json(404, { error: 'Harness job not found' });
      if (data.requested_by !== (user.email || user.id)) return json(403, { error: 'Forbidden' });
      return json(200, data);
    }

    if (action === 'delete') {
      const jobId = String(body.jobId || '');
      if (!jobId) return json(400, { error: 'jobId required' });
      const data = await store().get(jobId, { type: 'json', consistency: 'strong' });
      if (data && data.requested_by !== (user.email || user.id)) return json(403, { error: 'Forbidden' });
      await store().delete(jobId);
      return json(200, { success: true });
    }

    const fixture = String(body.fixture || '').trim();
    if (!['misconduct','performance','retrenchment','custom'].includes(fixture)) {
      return json(400, { error: 'Unknown test fixture' });
    }
    if (fixture === 'custom' && (!body.facts || typeof body.facts !== 'object' || Array.isArray(body.facts))) {
      return json(400, { error: 'Custom test requires a facts object' });
    }

    const jobId = crypto.randomUUID();
    const requestedBy = user.email || user.id;
    const queued = {
      harness: 'live_drafting_harness',
      jobId,
      status: 'queued',
      fixture,
      requested_by: requestedBy,
      queued_at: new Date().toISOString()
    };
    await store().setJSON(jobId, queued);

    const payload = {
      jobId,
      fixture,
      facts: fixture === 'custom' ? body.facts : null,
      requested_by: requestedBy
    };
    const raw = JSON.stringify(payload);
    const endpoint = `${siteBaseUrl(event)}/.netlify/functions/live_drafting_harness-background`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vrs-internal-signature': sign(raw)
      },
      body: raw
    });

    if (!response.ok && response.status !== 202) {
      const text = await response.text();
      await store().setJSON(jobId, {
        ...queued,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: `Could not queue background drafting: ${response.status} ${text.slice(0, 300)}`
      });
      return json(500, { error: 'Could not queue live drafting job', detail: text.slice(0, 300) });
    }

    return json(202, { success: true, jobId, status: 'queued' });
  } catch (error) {
    const message = String(error.message || 'Unknown error');
    return json(message === 'Unauthorized' ? 401 : 500, { error: message });
  }
};