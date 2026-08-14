const fs = require('fs');
const path = 'admin-workstation.html';
let s = fs.readFileSync(path, 'utf8');
const old = `    async function generateDraft(id) {
      const btn = $('btn-generate-' + id);
      btn.disabled = true;
      btn.textContent = 'Drafting...';
      try {
        const res = await fetch('/.netlify/functions/generate_letter', { method: 'POST', headers: headers(), body: JSON.stringify({ caseId: id }) });
        let result = {}; try { result = await res.json(); } catch (e) {}
        if (!res.ok) throw new Error(result.error || 'Draft generation failed.');
        toast(result.message || 'Draft generation started.');
        await fetchCases();
      } catch (e) {
        toast(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Draft Letter';
      }
    }
`;
const replacement = `    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async function pollDraftGeneration(id, options = {}) {
      const timeoutMs = options.timeoutMs || 180000;
      const intervalMs = options.intervalMs || 4000;
      const started = Date.now();

      while (Date.now() - started < timeoutMs) {
        await sleep(intervalMs);
        const res = await fetch('/.netlify/functions/get_cases', { headers: headers() });
        if (!res.ok) throw new Error('Could not refresh drafting status.');
        const freshCases = await res.json();
        const current = freshCases.find(c => c.id === id);
        if (!current) throw new Error('Case could not be found while checking the draft.');

        casesData = freshCases;

        if (current.draft_letter && !['generating', 'generation_failed'].includes(current.letter_status)) {
          selectedCaseId = id;
          render();
          toast('Draft ready for review.');
          return current;
        }

        if (current.letter_status === 'generation_failed') {
          selectedCaseId = id;
          render();
          const details = current.case_facts?.wp_generation_error;
          throw new Error(details ? 'Draft generation failed: ' + details : 'Draft generation failed. Please try again.');
        }

        if (selectedCaseId === id) {
          const btn = $('btn-generate-' + id);
          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating letter…';
          }
        }
      }

      await fetchCases();
      throw new Error('The draft is still being generated. The case has been refreshed; please check again shortly.');
    }

    async function generateDraft(id) {
      const btn = $('btn-generate-' + id);
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Starting…';
      }
      try {
        const res = await fetch('/.netlify/functions/generate_letter', { method: 'POST', headers: headers(), body: JSON.stringify({ caseId: id }) });
        let result = {}; try { result = await res.json(); } catch (e) {}

        if (!res.ok) {
          if (res.status === 409 && /generating/i.test(result.error || '')) {
            toast('This letter is already being generated. I’ll keep checking for the completed draft.');
          } else {
            throw new Error(result.error || 'Draft generation failed.');
          }
        } else {
          toast('Draft generation started. You can stay on this page while I prepare it.');
        }

        await fetchCases();
        const activeBtn = $('btn-generate-' + id);
        if (activeBtn) {
          activeBtn.disabled = true;
          activeBtn.textContent = 'Generating letter…';
        }
        await pollDraftGeneration(id);
      } catch (e) {
        toast(e.message || 'Draft generation failed.');
        await fetchCases();
      }
    }
`;
if (!s.includes(old)) throw new Error('Target generateDraft block not found');
s = s.replace(old, replacement);
fs.writeFileSync(path, s);
