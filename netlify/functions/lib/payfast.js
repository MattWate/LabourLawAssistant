const crypto = require('crypto');

const PAYFAST_FIELD_ORDER = [
  'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
  'name_first', 'name_last', 'email_address', 'cell_number',
  'm_payment_id', 'amount', 'item_name', 'item_description',
  'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
  'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
  'email_confirmation', 'confirmation_address',
  'payment_method', 'subscription_type', 'billing_date', 'recurring_amount',
  'frequency', 'cycles'
];

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

function orderedKeys(data = {}) {
  const present = new Set(Object.keys(data).filter(key => key !== 'signature'));
  const ordered = PAYFAST_FIELD_ORDER.filter(key => present.has(key));
  const remaining = Object.keys(data).filter(key => key !== 'signature' && !ordered.includes(key));
  return [...ordered, ...remaining];
}

function buildSignatureString(data = {}, passphrase = '') {
  const pairs = orderedKeys(data)
    .filter(key => data[key] !== undefined && data[key] !== null && String(data[key]).trim() !== '')
    .map(key => `${key}=${encodePayfastValue(data[key])}`);

  if (passphrase) pairs.push(`passphrase=${encodePayfastValue(passphrase)}`);
  return pairs.join('&');
}

function generateSignature(data = {}, passphrase = process.env.PAYFAST_PASSPHRASE || '') {
  return crypto.createHash('md5').update(buildSignatureString(data, passphrase)).digest('hex');
}

// Checkout signatures are built from our canonical outgoing field order.
function verifySignature(data = {}, passphrase = process.env.PAYFAST_PASSPHRASE || '') {
  if (!data.signature) return false;
  const expected = generateSignature(data, passphrase);
  return String(data.signature).toLowerCase() === expected.toLowerCase();
}

// ITN signatures must preserve the order in which PayFast posted the fields.
// Parsing into an object and then re-ordering them can invalidate an otherwise
// legitimate notification, so verification is performed from the raw form body.
function buildRawItnSignatureString(rawBody = '', passphrase = '') {
  const params = new URLSearchParams(rawBody || '');
  const pairs = [];

  for (const [key, value] of params.entries()) {
    if (key === 'signature') continue;
    if (value === undefined || value === null || String(value).trim() === '') continue;
    pairs.push(`${key}=${encodePayfastValue(value)}`);
  }

  if (passphrase) pairs.push(`passphrase=${encodePayfastValue(passphrase)}`);
  return pairs.join('&');
}

function verifyRawItnSignature(rawBody = '', passphrase = process.env.PAYFAST_PASSPHRASE || '') {
  const params = new URLSearchParams(rawBody || '');
  const received = params.get('signature');
  if (!received) return false;
  const expected = crypto.createHash('md5').update(buildRawItnSignatureString(rawBody, passphrase)).digest('hex');
  return String(received).toLowerCase() === expected.toLowerCase();
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
  return `JUSTINE-${String(caseId || 'CASE').slice(0, 8)}-${Date.now()}-${suffix}`;
}

function buildCheckoutFields(fields = {}) {
  const required = ['merchant_id', 'merchant_key', 'amount', 'item_name', 'm_payment_id'];
  required.forEach(key => {
    if (!fields[key]) throw new Error(`Missing Payfast checkout field: ${key}`);
  });
  const cleanFields = {};
  orderedKeys(fields).forEach(key => {
    if (fields[key] !== undefined && fields[key] !== null && String(fields[key]).trim() !== '') cleanFields[key] = fields[key];
  });
  cleanFields.signature = generateSignature(cleanFields);
  return cleanFields;
}

function fieldsToQuery(fields = {}) {
  const params = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => params.append(key, String(value)));
  return params.toString();
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
  verifyRawItnSignature,
  buildRawItnSignatureString,
  parseFormBody,
  amountToPayfast,
  generatePaymentId,
  buildCheckoutFields,
  fieldsToQuery,
  validateWithPayfast
};