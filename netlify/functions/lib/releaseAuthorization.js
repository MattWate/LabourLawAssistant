function decodeJwtPayload(token = '') {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (error) {
    return {};
  }
}

function assertReleaseAuthorised({ user, authHeader }) {
  if (!user?.id) {
    const error = new Error('Authenticated Supabase user required before releasing a letter.');
    error.code = 'RELEASE_NOT_AUTHORISED';
    throw error;
  }

  const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
  const claims = decodeJwtPayload(token);
  const aal = String(claims.aal || 'aal1');


  return {
    aal,
    permission_source: 'authenticated_supabase_user',
    user_id: user.id,
    user_email: user.email || null
  };
}

module.exports = { decodeJwtPayload, assertReleaseAuthorised };
