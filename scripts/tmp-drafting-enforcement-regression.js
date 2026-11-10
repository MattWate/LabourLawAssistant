const assert = require('assert');
const { enforceOutwardDraftRules, cleanOutwardText } = require('../netlify/functions/lib/claudeDrafting');

function structure(settlementTerms, legalText='') {
  return {
    part_a_letter: {
      opening_paragraphs: [],
      legal_claims: [{ title: 'Test', text: legalText }],
      settlement_intro: '',
      settlement_terms: settlementTerms,
      conclusion_paragraphs: []
    }
  };
}

// 1) Performance: no cross-case safety contamination and duplicate compensation collapses.
{
  const draft = structure([
    'Compensation on an ex gratia basis calibrated to the absence of a PIP and the compressed three-week improvement period under section 194(1) of the LRA.',
    'Payment of ex gratia compensation calibrated to the higher end of the section 194(1) range because no formal PIP was provided.',
    'Payment in lieu of notice under sections 37 and 38 of the BCEA.'
  ]);
  const out = enforceOutwardDraftRules(draft, { track:'UD-POOR_PERFORMANCE', merit_band:'HIGH', structured_case_facts:{} });
  const terms = out.part_a_letter.settlement_terms;
  assert.equal(terms.filter(x => /compensation|ex gratia|settlement amount/i.test(x)).length, 1, 'duplicate compensation term survived');
  assert(!JSON.stringify(out).toLowerCase().includes('safety context'), 'safety context was injected into performance case');
}

// 2) Pregnancy/retrenchment: preserve case-specific 24-month AUD reasoning instead of overwriting with 12-month boilerplate.
{
  const comp = 'Compensation on an ex gratia basis calibrated to the pregnancy-linked automatically unfair dismissal exposure under section 194(3) of the LRA, including the potential 24-month compensation ceiling.';
  const draft = structure([comp]);
  const out = enforceOutwardDraftRules(draft, { track:'UD-RETRENCHMENT', merit_band:'HIGH', override_flags:['PREGNANCY'], structured_case_facts:{protected_ground:'pregnancy'} });
  assert(out.part_a_letter.settlement_terms[0].includes('24-month'), '24-month AUD rationale was overwritten');
  assert(!out.part_a_letter.settlement_terms[0].includes('safety context'), 'safety context was injected into retrenchment case');
}

// 3) Current-law cleaner: remove the self-referential replacement phrase rather than converting Schedule 8 into a second current-Code reference.
{
  const input = 'The applicable framework is the Code of Practice: Dismissal, 2025, which replaced the former Schedule 8 Code of Good Practice on Dismissal, in particular paragraph 11.';
  const cleaned = cleanOutwardText(input);
  assert(!/which replaced the former/i.test(cleaned), 'obsolete replacement clause survived');
  assert.equal((cleaned.match(/Code of Practice: Dismissal, 2025/g)||[]).length, 1, 'current Code citation duplicated');
}

// 4) Notice wording: enforcement normalises to explicit complementary section 37/38 wording.
{
  const draft = structure(['Payment in lieu of notice under section 37 and section 38 of the BCEA.']);
  const out = enforceOutwardDraftRules(draft, { track:'UD-MISCONDUCT', merit_band:'HIGH', structured_case_facts:{} });
  const notice = out.part_a_letter.settlement_terms.find(x => /notice/i.test(x));
  assert(/section 37/i.test(notice) && /section 38/i.test(notice), 'notice term missing sections 37/38');
  assert(/payment in lieu of notice not worked/i.test(notice), 'notice term does not explain section 38 payment mechanism');
}

console.log('PASS drafting enforcement regression');
