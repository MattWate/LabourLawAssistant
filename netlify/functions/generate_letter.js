const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function canGenerateWpLetter(facts = {}) {
  if (facts.wp_eligible !== true) return false;
  if (facts.track === 'ANC') return false;
  if (facts.hard_disqualifier) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing Authentication Token' }) };
  }

  try {
    const { caseId } = JSON.parse(event.body || '{}');
    if (!caseId) return { statusCode: 400, body: JSON.stringify({ error: 'Case ID required' }) };

    const { data: caseData, error: caseErr } = await supabase
      .from('cases')
      .select('case_facts')
      .eq('id', caseId)
      .single();

    if (caseErr || !caseData) throw new Error('Case not found');

    const facts = caseData.case_facts || {};

    if (!canGenerateWpLetter(facts)) {
      await supabase
        .from('cases')
        .update({
          letter_status: 'not_applicable',
          case_facts: {
            ...facts,
            wp_letter_status: 'NOT_APPLICABLE',
            wp_generation_blocked_reason: facts.track === 'ANC'
              ? 'Ancillary matters do not generate Without Prejudice demand letters.'
              : 'The Strategic Engagement Matrix did not recommend a Without Prejudice letter.'
          }
        })
        .eq('id', caseId);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          blocked: true,
          message: 'This case is not eligible for a Without Prejudice demand letter under the current scoring matrix.'
        })
      };
    }

    const { data: settingData } = await supabase.from('system_settings').select('*');
    const settings = {};
    if (settingData) settingData.forEach(row => { settings[row.setting_name] = row.setting_value; });

    const activeLLM = settings.active_llm || 'gemini';
    const firmName = settings.firm_name || 'Legal Consultants';
    const firmAddress = settings.firm_address || '123 Legal Way, South Africa';
    const firmContact = settings.firm_contact || 'info@legalconsultants.co.za';

    const prompt = `
You are a Senior South African Labour Lawyer working for a firm named "${firmName}".

Write a formal, professional "Without Prejudice" demand letter based ONLY on the structured case facts below.

Do not invent legal citations. Use only the legal basis listed in the case facts.
Do not change the merit band, scores, WP type, or recommendation.
Do not tell the client the letter has been sent. This is a draft awaiting attorney release.

--- FIRM LETTERHEAD INFO ---
Firm Name: ${firmName}
Firm Address: ${firmAddress}
Firm Contact: ${firmContact}
----------------------------

CLIENT NAME: ${facts.client_name || 'N/A'}
EMPLOYER NAME: ${facts.employer_name || 'N/A'}
EMPLOYER CONTACT: ${facts.employer_contact_details || 'N/A'}
TRACK: ${facts.track_label || facts.track || 'N/A'}
WP TYPE: ${facts.wp_type || 'N/A'}
MERIT BAND: ${facts.merit_band || 'N/A'}
SUBSTANTIVE SCORE: ${facts.substantive_score || 'N/A'} / 10
PROCEDURAL SCORE: ${facts.procedural_score || 'N/A'} / 10
DATE OF INCIDENT: ${facts.incident_date || 'N/A'}
INCIDENT SUMMARY: ${facts.incident_description || 'N/A'}
LEGAL BASIS: ${(facts.legal_basis || []).join('; ') || 'N/A'}
SCORING BREAKDOWN: ${JSON.stringify(facts.scoring_breakdown || [])}
RECOMMENDED NEXT STEP: ${facts.recommended_next_step || facts.overall_viability || 'N/A'}

REQUIREMENTS:
1. Start with the firm letterhead info at the top, formatted professionally.
2. Include the current date.
3. Include "WITHOUT PREJUDICE" clearly near the top.
4. Address the employer formally.
5. State the dispute accurately based on the track and facts.
6. If WP TYPE is PROCEDURAL_ONLY, focus on procedural defects and do not overstate substantive merit.
7. If WP TYPE is SUBSTANTIVE_ONLY, focus on substantive unfairness and avoid claiming procedural defects unless captured in the scoring breakdown.
8. Make a settlement-orientated demand aligned to South African labour law.
9. State that the draft is subject to attorney review and release.
10. Return ONLY the letter text. Do not include markdown blocks, intro, or outro text.
`;

    let letterText = '';
    if (activeLLM === 'openai' && openai) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }]
      });
      letterText = completion.choices[0].message.content.trim();
    } else {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent(prompt);
      letterText = result.response.text().trim();
    }

    await supabase
      .from('cases')
      .update({
        draft_letter: letterText,
        letter_status: 'pending_review',
        case_facts: {
          ...facts,
          wp_letter_status: 'GENERATED_PENDING'
        }
      })
      .eq('id', caseId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        letter: letterText,
        message: 'Draft generated and held pending attorney review.'
      })
    };
  } catch (error) {
    console.error('Drafting Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
