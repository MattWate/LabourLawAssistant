const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com',
  'yahoo.com','yahoo.co.uk','icloud.com','me.com','proton.me','protonmail.com',
  'aol.com','mail.com','gmx.com','gmx.co.uk','fastmail.com'
]);

function cleanEmail(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function emailDomain(value = '') {
  const email = cleanEmail(value);
  return email ? email.split('@')[1] : null;
}

function isPersonalProvider(domain = '') {
  return PERSONAL_EMAIL_DOMAINS.has(String(domain || '').toLowerCase());
}

function compareClientEmployerEmail({ clientEmail, employerEmail }) {
  const client = cleanEmail(clientEmail);
  const employer = cleanEmail(employerEmail);
  const clientDomain = emailDomain(client);
  const employerDomain = emailDomain(employer);

  if (!client) return { ok: false, reason: 'invalid_client_email', client_email: null };
  if (!employer || !clientDomain || !employerDomain) {
    return { ok: true, reason: 'employer_domain_unavailable', client_email: client };
  }

  if (clientDomain === employerDomain && !isPersonalProvider(clientDomain)) {
    return {
      ok: false,
      reason: 'matches_employer_domain',
      client_email: client,
      client_domain: clientDomain,
      employer_domain: employerDomain
    };
  }

  return {
    ok: true,
    reason: clientDomain === employerDomain ? 'shared_personal_provider' : 'different_domain',
    client_email: client,
    client_domain: clientDomain,
    employer_domain: employerDomain
  };
}

module.exports = {
  cleanEmail,
  emailDomain,
  isPersonalProvider,
  compareClientEmployerEmail
};
