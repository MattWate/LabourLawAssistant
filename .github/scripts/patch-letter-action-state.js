const fs = require('fs');
const path = 'admin-workstation.html';
let s = fs.readFileSync(path, 'utf8');

const oldButtons = `        const buttons = sent
          ? '<button class="btn ghost" disabled>Letter Released</button>'
          : approved
            ? '<button class="btn ghost" onclick="manageLetter(\\'' + c.id + '\\',\\'save\\')">Save Changes</button><button id="btn-send-' + c.id + '" class="btn success" onclick="manageLetter(\\'' + c.id + '\\',\\'send\\')">Release & Send Letter</button>'
            : '<button class="btn ghost" onclick="manageLetter(\\'' + c.id + '\\',\\'save\\')">Save Draft</button><button id="btn-approve-' + c.id + '" class="btn success" onclick="manageLetter(\\'' + c.id + '\\',\\'approve\\')">Approve Letter</button>';
        return '<div class="card"><h3>Drafted Letter</h3><textarea id="letter-editor" class="letter" ' + (sent ? 'readonly' : '') + '>' + esc(c.draft_letter) + '</textarea>' + audit + '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;flex-wrap:wrap">' + buttons + '</div></div>';
`;

const newButtons = `        const buttons = sent
          ? '<button class="btn ghost" disabled>Letter Released</button>'
          : approved
            ? '<button id="btn-save-' + c.id + '" class="btn ghost" onclick="manageLetter(\\'' + c.id + '\\',\\'save\\')">Save Revised Draft</button><button id="btn-send-' + c.id + '" class="btn success" onclick="manageLetter(\\'' + c.id + '\\',\\'send\\')">Release & Send Letter</button>'
            : '<button id="btn-save-' + c.id + '" class="btn ghost" onclick="manageLetter(\\'' + c.id + '\\',\\'save\\')">Save Draft</button><button id="btn-approve-' + c.id + '" class="btn success" onclick="manageLetter(\\'' + c.id + '\\',\\'approve\\')">Approve Letter</button>';
        const editorInput = approved && !sent ? ' oninput="markApprovedLetterEdited(\\'' + c.id + '\\')"' : '';
        return '<div class="card"><h3>Drafted Letter</h3><textarea id="letter-editor" class="letter" ' + (sent ? 'readonly' : '') + editorInput + '>' + esc(c.draft_letter) + '</textarea>' + audit + '<div id="letter-action-note-' + c.id + '" style="margin-top:10px;color:var(--muted);font-size:.86rem"></div><div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;flex-wrap:wrap">' + buttons + '</div></div>';
`;
if (!s.includes(oldButtons)) throw new Error('letterCard button block not found');
s = s.replace(oldButtons, newButtons);

const oldManage = `    async function manageLetter(id, action) {
      const editor = $('letter-editor');
      const draft = editor ? editor.value.trim() : '';
      if (!draft) return toast('The letter is empty.');
      if (action === 'approve' && !confirm('Approve this exact version of the letter? It will still require a separate release action.')) return;
      if (action === 'send' && !confirm('Release and email this approved letter to the employer now? This action cannot be undone.')) return;
      const btn = $(action === 'approve' ? 'btn-approve-' + id : action === 'send' ? 'btn-send-' + id : '');
      if (btn) { btn.disabled = true; btn.textContent = action === 'send' ? 'Sending...' : action === 'approve' ? 'Approving...' : 'Saving...'; }
      try {
        const res = await fetch('/.netlify/functions/manage_letter_release', { method:'POST', headers:headers(), body:JSON.stringify({ caseId:id, action, draft_letter:draft }) });
        let result={}; try { result=await res.json(); } catch(e) {}
        if (!res.ok) throw new Error(result.error || 'Letter action failed.');
        if (action === 'save') toast('Draft saved and returned to pending review.');
        if (action === 'approve') toast('Letter approved. It is now ready for release.');
        if (action === 'send') toast('Letter sent to ' + (result.sent_to || 'the employer') + '.');
        await fetchCases();
      } catch(e) {
        toast(e.message || 'Letter action failed.');
        if (btn) { btn.disabled=false; btn.textContent=action==='send'?'Release & Send Letter':action==='approve'?'Approve Letter':'Save Draft'; }
      }
    }
`;

const newManage = `    function setLetterActionBusy(id, busy, action = '') {
      const ids = ['btn-save-' + id, 'btn-approve-' + id, 'btn-send-' + id];
      ids.forEach(buttonId => {
        const button = $(buttonId);
        if (button) button.disabled = busy;
      });
      const active = action === 'approve' ? $('btn-approve-' + id) : action === 'send' ? $('btn-send-' + id) : $('btn-save-' + id);
      if (busy && active) active.textContent = action === 'send' ? 'Sending…' : action === 'approve' ? 'Approving…' : 'Saving…';
    }

    function markApprovedLetterEdited(id) {
      const send = $('btn-send-' + id);
      const save = $('btn-save-' + id);
      const note = $('letter-action-note-' + id);
      if (send) {
        send.disabled = true;
        send.textContent = 'Reapproval Required';
      }
      if (save) save.textContent = 'Save Revised Draft';
      if (note) note.textContent = 'This approved letter has been edited. Save the revised draft, then approve the new version before release.';
    }

    async function manageLetter(id, action) {
      const editor = $('letter-editor');
      const draft = editor ? editor.value.trim() : '';
      if (!draft) return toast('The letter is empty.');
      if (action === 'approve' && !confirm('Approve this exact version of the letter? It will still require a separate release action.')) return;
      if (action === 'send' && !confirm('Release and email this approved letter to the employer now? This action cannot be undone.')) return;

      setLetterActionBusy(id, true, action);
      try {
        const res = await fetch('/.netlify/functions/manage_letter_release', { method:'POST', headers:headers(), body:JSON.stringify({ caseId:id, action, draft_letter:draft }) });
        let result={}; try { result=await res.json(); } catch(e) {}
        if (!res.ok) throw new Error(result.error || 'Letter action failed.');
        if (action === 'save') toast('Revised draft saved. This version now requires approval before release.');
        if (action === 'approve') toast('Letter approved. It is now ready for release.');
        if (action === 'send') toast('Letter sent to ' + (result.sent_to || 'the employer') + '.');
        await fetchCases();
      } catch(e) {
        toast(e.message || 'Letter action failed.');
        await fetchCases();
      }
    }
`;
if (!s.includes(oldManage)) throw new Error('manageLetter block not found');
s = s.replace(oldManage, newManage);

fs.writeFileSync(path, s);
