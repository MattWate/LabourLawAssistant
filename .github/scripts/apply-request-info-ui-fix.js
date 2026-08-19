const fs = require('fs');
const path = 'admin-workstation.html';
let s = fs.readFileSync(path, 'utf8');

const oldModal = `<div id="request-info-modal" class="modal">
    <div class="modal-card glass">
      <div class="modal-head"><div><h2>Request More Information</h2><p>Prepare questions for the client. WhatsApp can plug into this later.</p></div><button class="btn ghost" onclick="closeModal('request-info-modal')">Close</button></div>`;
const newModal = `<div id="request-info-modal" class="modal">
    <div class="modal-card glass">
      <div class="modal-head"><div><h2>Request More Information</h2><p>Send a question to the client or record an offline request.</p></div><button class="btn ghost" onclick="closeModal('request-info-modal')">Close</button></div>`;
if (!s.includes(oldModal)) throw new Error('Request info modal header not found');
s = s.replace(oldModal, newModal);

const oldButton = `<div class="modal-actions"><button class="btn ghost" onclick="closeModal('request-info-modal')">Cancel</button><button class="btn warn" onclick="saveInfoRequest()">Save Question</button></div>`;
const newButton = `<div class="modal-actions"><button class="btn ghost" onclick="closeModal('request-info-modal')">Cancel</button><button id="q-submit" class="btn warn" onclick="saveInfoRequest()">Send / Record Request</button></div>`;
if (!s.includes(oldButton)) throw new Error('Request info modal action not found');
s = s.replace(oldButton, newButton);

const start = s.indexOf('    async function saveInfoRequest() {');
const end = s.indexOf('\n    async function createManualCase()', start);
if (start === -1 || end === -1) throw new Error('saveInfoRequest function not found');

const replacement = `    async function saveInfoRequest() {
      const c = casesData.find(x => x.id === selectedCaseId);
      if (!c) return toast('Select a case first.');
      const question = $('q-text').value.trim();
      if (!question) return toast('Add a question first.');
      const channel = $('q-channel').value;
      const answerType = $('q-type').value;
      const btn = $('q-submit');
      if (btn) { btn.disabled = true; btn.textContent = (channel === 'whatsapp' || channel === 'email') ? 'Sending…' : 'Saving…'; }

      try {
        const res = await authFetch('/.netlify/functions/request_case_info', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ caseId: c.id, question, channel, answer_type: answerType })
        });
        let result = {};
        try { result = await res.json(); } catch (e) {}
        if (!res.ok) throw new Error(result.error || 'Could not send the information request.');

        $('q-text').value = '';
        closeModal('request-info-modal');
        if (result.delivery?.sent && channel === 'whatsapp') toast('Question sent to client via WhatsApp.');
        else if (result.delivery?.sent && channel === 'email') toast('Question sent to client by email.');
        else toast('Client information request recorded.');
        await fetchCases();
      } catch (e) {
        toast(e.message || 'Could not send the information request.');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Send / Record Request'; }
      }
    }
`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(path, s);
console.log('Request info UI patched');
