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

function authorisedReleaseEmails() {
  return String(process.env.VRS_RELEASE_AUTHORISED_EMAILS || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

function releasePermission(user = {}) {
  const email = String(user.email || '').toLowerCase();
  if (user.app_metadata?.can_release_letters === true) return { allowed: true, source: 'app_metadata' };
  if (authorisedReleaseEmails().includes(email)) return { allowed: true, source: 'environment_allowlist' };
  return { allowed: false, source: 'none' };
}

function assertReleaseAuthorised({ user, authHeader }) {
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
  const claims = decodeJwtPayload(token);
  const aal = String(claims.aal || 'aal1');
  const permission = releasePermission(user);

  if (!permission.allowed) {
    const error = new Error('Release not authorised for this user. Sasha or an authorised releaser must send the letter.');
    error.code = 'RELEASE_NOT_AUTHORISED';
    throw error;
  }

  if (aal !== 'aal2') {
    const error = new Error('MFA is required before releasing a letter. Sign in with a second factor and try again.');
    error.code = 'MFA_REQUIRED';
    throw error;
  }

  return { aal, permission_source: permission.source };
}

module.exports = { decodeJwtPayload, releasePermission, assertReleaseAuthorised };
