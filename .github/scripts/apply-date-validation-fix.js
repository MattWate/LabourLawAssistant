const fs = require('fs');

function replaceOnce(content, from, to, label) {
  if (!content.includes(from)) throw new Error(`Expected text not found: ${label}`);
  return content.replace(from, to);
}

// WhatsApp intake: validate and normalise dates before saving or moving on.
{
  const file = 'netlify/functions/lib/whatsappConversation.js';
  let content = fs.readFileSync(file, 'utf8');

  content = replaceOnce(
    content,
    "const { createClient } = require('@supabase/supabase-js');",
    "const { createClient } = require('@supabase/supabase-js');\nconst { validateAndNormaliseDate } = require('./dateValidation');",
    'WhatsApp date validator import'
  );

  content = replaceOnce(
    content,
    "const date = (prompt, saveAs, next) => ({ type: 'date', prompt, saveAs, next });",
    "const date = (prompt, saveAs, next, dateRules = {}) => ({ type: 'date', prompt, saveAs, next, dateRules });",
    'WhatsApp date helper'
  );

  const questionReplacements = [
    ["FIRED_DATE: date('What was the exact date of your dismissal? Please use YYYY-MM-DD or DD/MM/YYYY.', 'incident_date', 'FIRED_REASON_TYPE')", "FIRED_DATE: date('What was the exact date of your dismissal? Please enter it as DD/MM/YYYY, for example 17/08/2026.', 'incident_date', 'FIRED_REASON_TYPE')"],
    ["RESIGN_DATE: date('What was the date you officially resigned?', 'incident_date', 'B2_INTOLERABLE_CONDUCT')", "RESIGN_DATE: date('What was the date you officially resigned? Please enter it as DD/MM/YYYY, for example 17/08/2026.', 'incident_date', 'B2_INTOLERABLE_CONDUCT')"],
    ["D1_HEARING_DATE: date('When is your disciplinary hearing scheduled?', 'hearing_date', 'D2_CHARGE_SHEET')", "D1_HEARING_DATE: date('When is your disciplinary hearing scheduled? Please enter it as DD/MM/YYYY, for example 17/08/2026.', 'hearing_date', 'D2_CHARGE_SHEET', { allowFuture: true })"],
    ["E3_RELEVANT_EVENT_DATE: date('What is the date of the relevant event?', 'relevant_event_date', 'E4_INTERNAL_RAISED')", "E3_RELEVANT_EVENT_DATE: date('What is the date of the relevant event? Please enter it as DD/MM/YYYY, for example 17/08/2026.', 'relevant_event_date', 'E4_INTERNAL_RAISED')"]
  ];
  for (const [from, to] of questionReplacements) content = replaceOnce(content, from, to, from.split(':')[0]);

  content = replaceOnce(
    content,
    "function validDate(value) {\n  return /^\\d{4}-\\d{2}-\\d{2}$/.test(value) || /^\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}$/.test(value);\n}\n",
    '',
    'legacy validDate helper'
  );

  content = replaceOnce(
    content,
    "  if (step.type === 'date') return validDate(String(value));",
    "  if (step.type === 'date') return validateAndNormaliseDate(String(value), step.dateRules || {}).ok;",
    'AI date skip validation'
  );

  const oldMerge = `  Object.entries(candidates).forEach(([key, value]) => {\n    if (!hasValue(value) || hasValue(merged[key])) return;\n    const confidence = Number(confidenceByField[key] ?? overallConfidence ?? 0);\n    if (confidence < AI_SKIP_CONFIDENCE) return;\n    merged[key] = value;\n    metadata[key] = { source: 'initial_narrative_ai', confidence, captured_at: new Date().toISOString() };\n  });`;
  const newMerge = `  Object.entries(candidates).forEach(([key, value]) => {\n    if (!hasValue(value) || hasValue(merged[key])) return;\n    const confidence = Number(confidenceByField[key] ?? overallConfidence ?? 0);\n    if (confidence < AI_SKIP_CONFIDENCE) return;\n\n    if (['incident_date', 'dismissal_date', 'resignation_date', 'relevant_event_date', 'hearing_date'].includes(key)) {\n      const dateResult = validateAndNormaliseDate(String(value), { allowFuture: key === 'hearing_date' });\n      if (!dateResult.ok) return;\n      merged[key] = dateResult.iso;\n    } else {\n      merged[key] = value;\n    }\n\n    metadata[key] = { source: 'initial_narrative_ai', confidence, captured_at: new Date().toISOString() };\n  });`;
  content = replaceOnce(content, oldMerge, newMerge, 'AI extracted date normalisation');

  const oldInputBlock = `  } else {\n    if (step.type === 'date' && !validDate(input)) return \`Please enter the date as YYYY-MM-DD or DD/MM/YYYY.\\n\\n\${step.prompt}\`;\n    if (step.minWords && wordCount(input) < step.minWords) return \`Please add a little more detail, ideally at least \${step.minWords} words.\\n\\n\${step.prompt}\`;\n    facts[step.saveAs] = input;\n    facts = markDirectAnswer(facts, step.saveAs);\n    next = resolveNextUnanswered(step.next, facts);\n  }`;
  const newInputBlock = `  } else {\n    let valueToSave = input;\n    if (step.type === 'date') {\n      const dateResult = validateAndNormaliseDate(input, step.dateRules || {});\n      if (!dateResult.ok) return \`\${dateResult.message}\\n\\n\${step.prompt}\`;\n      valueToSave = dateResult.iso;\n    }\n    if (step.minWords && wordCount(input) < step.minWords) return \`Please add a little more detail, ideally at least \${step.minWords} words.\\n\\n\${step.prompt}\`;\n    facts[step.saveAs] = valueToSave;\n    facts = markDirectAnswer(facts, step.saveAs);\n    next = resolveNextUnanswered(step.next, facts);\n  }`;
  content = replaceOnce(content, oldInputBlock, newInputBlock, 'WhatsApp typed date validation');

  fs.writeFileSync(file, content);
}

// Scoring: only calculate the ordinary 30-day referral window where it applies,
// and never calculate from an invalid or future date.
{
  const file = 'netlify/functions/lib/scoringEngine.js';
  let content = fs.readFileSync(file, 'utf8');

  content = replaceOnce(
    content,
    "const { determineRecommendation } = require('./strategicMatrix');",
    "const { determineRecommendation } = require('./strategicMatrix');\nconst { validateAndNormaliseDate } = require('./dateValidation');",
    'scoring date validator import'
  );

  const oldCcma = `function ccmaStatus(facts = {}) {\n  const dateValue = facts.incident_date || facts.dismissal_date || facts.resignation_date || facts.relevant_event_date;\n  if (!dateValue) return { status: 'UNKNOWN', daysElapsed: null, daysRemaining: null };\n  const date = new Date(dateValue);\n  if (Number.isNaN(date.getTime())) return { status: 'UNKNOWN', daysElapsed: null, daysRemaining: null };\n  const daysElapsed = Math.floor((Date.now() - date.getTime()) / 86400000);\n  return daysElapsed <= 30\n    ? { status: 'WITHIN_WINDOW', daysElapsed, daysRemaining: 30 - daysElapsed }\n    : { status: 'LAPSED-CONDONATION', daysElapsed, daysRemaining: 30 - daysElapsed };\n}`;
  const newCcma = `function ccmaStatus(facts = {}) {\n  const track = inferTrack(facts);\n  const statusText = clean(facts.disc_status || facts.employment_status || facts.category);\n  const dismissalWindowApplies = track.startsWith('UD-') || track === 'CD' || (track === 'AUD' && (statusText.includes('dismiss') || statusText.includes('fire')));\n\n  if (!dismissalWindowApplies) {\n    return { status: 'NOT_APPLICABLE', daysElapsed: null, daysRemaining: null, daysOverdue: null };\n  }\n\n  const dateValue = facts.incident_date || facts.dismissal_date || facts.resignation_date;\n  if (!dateValue) return { status: 'UNKNOWN', reason: 'missing_date', daysElapsed: null, daysRemaining: null, daysOverdue: null };\n\n  const parsed = validateAndNormaliseDate(dateValue, { allowFuture: false });\n  if (!parsed.ok) return { status: 'UNKNOWN', reason: parsed.reason, daysElapsed: null, daysRemaining: null, daysOverdue: null };\n\n  const now = new Date();\n  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());\n  const daysElapsed = Math.floor((todayUtc - parsed.date.getTime()) / 86400000);\n\n  if (daysElapsed <= 30) {\n    return { status: 'WITHIN_WINDOW', eventDate: parsed.iso, daysElapsed, daysRemaining: 30 - daysElapsed, daysOverdue: 0 };\n  }\n\n  return { status: 'LAPSED-CONDONATION', eventDate: parsed.iso, daysElapsed, daysRemaining: null, daysOverdue: daysElapsed - 30 };\n}`;
  content = replaceOnce(content, oldCcma, newCcma, 'CCMA date calculation');

  const oldDeadline = "  const deadline = result.ccma_deadline_status.status === 'WITHIN_WINDOW' ? `${result.ccma_deadline_status.daysRemaining} days remaining in the ordinary 30-day CCMA referral window.` : result.ccma_deadline_status.status === 'LAPSED-CONDONATION' ? 'The ordinary 30-day CCMA referral window appears to have lapsed. Condonation may be required.' : 'The CCMA deadline cannot be confirmed because the relevant date is missing or invalid.';";
  const newDeadline = "  const deadline = result.ccma_deadline_status.status === 'WITHIN_WINDOW' ? `${result.ccma_deadline_status.daysRemaining} days remaining in the ordinary 30-day CCMA referral window.` : result.ccma_deadline_status.status === 'LAPSED-CONDONATION' ? `The ordinary 30-day CCMA referral window appears to have lapsed by ${result.ccma_deadline_status.daysOverdue} days. Condonation may be required.` : result.ccma_deadline_status.status === 'NOT_APPLICABLE' ? 'The ordinary 30-day dismissal referral calculation does not apply to this matter.' : 'The CCMA deadline cannot be confirmed because the relevant date is missing or invalid.';";
  content = replaceOnce(content, oldDeadline, newDeadline, 'deadline presentation');

  fs.writeFileSync(file, content);
}

// Legacy admin review: do not display negative days remaining.
{
  const file = 'admin-review.html';
  let content = fs.readFileSync(file, 'utf8');
  const oldDisplay = "${fact('CCMA Deadline', f.ccma_deadline_status ? `${f.ccma_deadline_status.status} (${f.ccma_deadline_status.daysRemaining ?? '—'} days remaining)` : '—')}";
  const newDisplay = "${fact('CCMA Deadline', f.ccma_deadline_status ? (f.ccma_deadline_status.status === 'LAPSED-CONDONATION' ? `${f.ccma_deadline_status.status} (${f.ccma_deadline_status.daysOverdue ?? '—'} days overdue)` : f.ccma_deadline_status.status === 'WITHIN_WINDOW' ? `${f.ccma_deadline_status.status} (${f.ccma_deadline_status.daysRemaining ?? '—'} days remaining)` : f.ccma_deadline_status.status) : '—')}";
  content = replaceOnce(content, oldDisplay, newDisplay, 'admin CCMA deadline display');
  fs.writeFileSync(file, content);
}

console.log('Applied date validation and CCMA deadline fixes.');
// Trigger workflow after workflow creation.
