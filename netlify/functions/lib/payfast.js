const crypto = require('crypto');

function normaliseEnv() {
  return String(process.env.PAYFAST_ENV || 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
}

function getPayfastBaseUrl() {
  return normaliseEnv() === 'live'
    ? 'https://www.payfast.co.za/eng/process'
    : 'https://sandbox.payfast.co.za/eng/process';
}

function getPayfastValidateUrl() {
  return normaliseEnv() === 'live'
    ? 'https://www.payfast.co.za/eng/query/validate'
    : 'https://sandbox.payfast.co.za/eng/query/validate';
}

function encodePayfastValue(value) {
  return encodeURIComponent(String(value).trim()).replace(/%20/g, '+');
}

function buildSignatureString(data = {}, passphrase = '') {
  const pairs = Object.keys(data)
    .filter(key => key !== 'signature')
    .filter(key => data[key] !== undefined && data[key] !== null && String(data[key]).trim() !== '')
    .sort()
    .map(key => `${key}=${encodePayfastValue(data[key])}`);

  if (passphrase) pairs.push(`passphrase=${encodePayfastValue(passphrase)}`);
  return pairs.join('&');
}

function generateSignature(data = {}, passphrase = process.env.PAYFAST_PASSPHRASE || '') {
  return crypto.createHash('md5').update(buildSignatureString(data, passphrase)).digest('hex');
}

function verifySignature(data = {}, passphrase = process.env.PAYFAST_PASSPHRASE || '') {
  if (!data.signature) return false;
  const expected = generateSignature(data, passphrase);
  return String(data.signature).toLowerCase() === expected.toLowerCase();
}

function parseFormBody(body = '') {
  const params = new URLSearchParams(body || '');
  const parsed = {};
  for (const [key, value] of params.entries()) parsed[key] = value;
  return parsed;
}

function amountToPayfast(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid Payfast amount');
  return amount.toFixed(2);
}

function generatePaymentId(caseId = '') {
  const suffix = crypto.randomBytes(6).toString('hex');
  return `JUSTINE-${String(caseId).slice(0, 8)}-${Date.now()}-${suffix}`;
}

async function validateWithPayfast(rawBody = '') {
  const response = await fetch(getPayfastValidateUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: rawBody
  });
  const text = await response.text();
  return { ok: response.ok && text.trim().toUpperCase() === 'VALID', status: response.status, body: text };
}

module.exports = {
  getPayfastBaseUrl,
  getPayfastValidateUrl,
  generateSignature,
  verifySignature,
  parseFormBody,
  amountToPayfast,
  generatePaymentId,
  validateWithPayfast
};