const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const INTERNAL_SIGNING_KEY = process.env.LETTER_GENERATION_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0'
    },
    body: JSON.stringify(body)
  };
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function siteBaseUrl(event) {
  const host = event.headers?.host || event.headers?.['x-forwarded-host'];
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  const configured = process.env.DEPLOY_PRIME_URL || process.env.URL;
  if (configured) return configured.replace(/\/$/, '');
  throw new Error('Could not determine site URL');
}

function internalSignature(rawBody) {
  if (!INTERNAL_SIGNING_KEY) throw new Error('Internal letter-generation signing key is not configured');
  return crypto.createHmac('sha256', INTERNAL_SIGNING_KEY).update(rawBody, 'utf8').digest('hex');
}

async function findReviewCase(token) {
  if (!token || token.length < 32) return null;
  const tokenHash = sha256(token);
  const { data, error } = await supabase
    .from('cases')
    .select('id,client_name,draft_letter,letter_status,status,case_facts')
    .eq('case_facts->>client_review_token_hash', tokenHash)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function validateReview(caseData) {
  const facts = caseData?.case_facts || {};
  const expiresAt = facts.client_review_expires_at ? new Date(facts.client_review_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    return { ok: false, status: 410, error: 'This review link has expired. Please contact VRS for a new link.' };
  }
  if (facts.client_review_completed_at) {
    return { ok: false, status: 409, error: 'This review link has already been used.' };
  }
  const currentHash = sha256(caseData.draft_letter || '');
  if (!caseData.draft_letter || facts.client_review_letter_hash !== currentHash || facts.approved_text_hash !== currentHash) {
    return { ok: false, status: 409, error: 'This letter has changed since the review link was issued. Please contact VRS for a new link.' };
  }
  return { ok: true, currentHash };
}

async function queueRevision(event, caseId) {
  const rawBody = JSON.stringify({ caseId, revision: true });
  const response = await fetch(`${siteBaseUrl(event)}/.netlify/functions/generate_letter-background`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vrs-internal-signature': internalSignature(rawBody)
    },
    body: rawBody
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not queue revised draft: ${response.status} ${text.slice(0, 400)}`);
  }
}

exports.handler = async (event) => {
  try {
    if (!supabase) throw new Error('Supabase is not configured');
    const token = event.queryStringParameters?.token || '';

    if (event.httpMethod === 'GET') {
      const caseData = await findReviewCase(token);
      if (!caseData) return json(404, { error: 'Review link not found.' });
      const validation = validateReview(caseData);
      if (!validation.ok) return json(validation.status, { error: validation.error });

      const facts = caseData.case_facts || {};
      return json(200, {
        case_reference: facts.case_reference || caseData.id,
        client_name: facts.client_name || caseData.client_name || 'Client',
        employer_name: facts.employer_name || 'your employer',
        letter: caseData.draft_letter,
        expires_at: facts.client_review_expires_at,
        revision_round: Number(facts.client_revision_round || 0)
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const caseData = await findReviewCase(token);
    if (!caseData) return json(404, { error: 'Review link not found.' });
    const validation = validateReview(caseData);
    if (!validation.ok) return json(validation.status, { error: validation.error });

    const request = JSON.parse(event.body || '{}');
    const action = String(request.action || '').trim().toLowerCase();
    const facts = caseData.case_facts || {};
    const now = new Date().toISOString();

    if (action === 'approve') {
      const updatedFacts = {
        ...facts,
        client_letter_approved_at: now,
        client_letter_approved_hash: validation.currentHash,
        client_review_completed_at: now,
        client_review_outcome: 'approved',
        client_requested_changes: null,
        wp_letter_status: 'CLIENT_APPROVED'
      };
      const { error } = await supabase.from('cases').update({
        status: 'client_approved_ready_to_send',
        letter_status: 'client_approved',
        case_facts: updatedFacts,
        updated_at: now
      }).eq('id', caseData.id);
      if (error) throw error;
      return json(200, { success: true, outcome: 'approved', message: 'Thank you. VRS has recorded your approval.' });
    }

    if (action === 'request_changes') {
      const changes = String(request.changes || '').trim();
      if (changes.length < 5) return json(400, { error: 'Please briefly explain the changes you need.' });
      if (changes.length > 4000) return json(400, { error: 'Please keep the requested changes under 4,000 characters.' });

      const revisionRound = Number(facts.client_revision_round || 0) + 1;
      const updatedFacts = {
        ...facts,
        client_review_completed_at: now,
        client_review_outcome: 'changes_requested',
        client_requested_changes: changes,
        client_revision_requested_at: now,
        client_revision_source_letter: caseData.draft_letter,
        client_revision_source_hash: validation.currentHash,
        client_revision_round: revisionRound,
        client_letter_approved_at: null,
        client_letter_approved_hash: null,
        letter_approved_at: null,
        letter_approved_by: null,
        approved_text_hash: null,
        letter_document_path: null,
        letter_document_filename: null,
        wp_letter_status: 'CLIENT_CHANGES_REQUESTED'
      };

      const { error } = await supabase.from('cases').update({
        status: 'client_changes_requested',
        letter_status: 'client_changes_requested',
        case_facts: updatedFacts,
        updated_at: now
      }).eq('id', caseData.id);
      if (error) throw error;

      try {
        await queueRevision(event, caseData.id);
        return json(202, {
          success: true,
          outcome: 'changes_requested',
          revision_queued: true,
          message: 'Your requested changes have been sent to VRS. A revised draft is now being prepared for VRS review.'
        });
      } catch (queueError) {
        console.error('Client revision queue failed:', { caseId: caseData.id, error: queueError.message });
        return json(202, {
          success: true,
          outcome: 'changes_requested',
          revision_queued: false,
          message: 'Your requested changes have been recorded. VRS will prepare the revised draft.'
        });
      }
    }

    return json(400, { error: 'Choose approve or request_changes.' });
  } catch (error) {
    console.error('Client letter review error:', error);
    return json(500, { error: 'The review request could not be processed. Please contact VRS.' });
  }
};
