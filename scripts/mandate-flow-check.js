const assert = require('assert');
const fs = require('fs');
const { CONSENT_CONFIG, mandateAcceptanceSnapshot } = require('../netlify/functions/lib/consentConfig');

const read = p => fs.readFileSync(p, 'utf8');

assert.strictEqual(CONSENT_CONFIG.mandate.version, '2026-11-03');
assert(CONSENT_CONFIG.mandate.text.includes('By accepting this mandate'));
assert(CONSENT_CONFIG.mandate.text.includes('receive monies which may be due to you'));

const snapshot = mandateAcceptanceSnapshot('test');
assert.strictEqual(snapshot.accepted, true);
assert.strictEqual(snapshot.channel, 'test');
assert.strictEqual(snapshot.version, '2026-11-03');
assert.strictEqual(snapshot.wording, CONSENT_CONFIG.mandate.text);

const web = read('index.html');
assert(web.includes('showMandateAcceptance()'));
assert(web.includes('I have read and accept the VRS Labour Law Consultants mandate.'));
assert(web.includes('mandate_acceptance: wantsLetter ? collectedFacts.mandate_acceptance : null'));

const ask = read('netlify/functions/ask.js');
assert(ask.includes('mandate_acceptance'));
assert(ask.includes('mandate_acceptance?.accepted === true'));

const wa = read('netlify/functions/lib/whatsappConversation.js');
assert(wa.includes("conversation.status === 'awaiting_mandate_acceptance'"));
assert(wa.includes("mandateAcceptanceSnapshot('whatsapp')"));
assert(wa.includes("status: 'awaiting_payment_consent'"));

const payment = read('netlify/functions/approve_case_for_payment.js');
assert(payment.includes('facts.mandate_acceptance?.accepted !== true'));
assert(payment.includes("status: 'awaiting_mandate_acceptance'"));
assert(payment.indexOf('facts.mandate_acceptance?.accepted !== true') < payment.indexOf('facts.payment_start_consent?.accepted !== true'));

const admin = read('admin-workstation.html');
assert(admin.includes("awaiting_mandate_acceptance:['Awaiting Mandate','amber']"));

console.log('PASS mandate acceptance flow checks');
