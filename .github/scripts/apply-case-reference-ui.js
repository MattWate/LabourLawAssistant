const fs = require('fs');

function replace(path, oldText, newText, label) {
  let s = fs.readFileSync(path, 'utf8');
  if (!s.includes(oldText)) throw new Error(`${label} not found in ${path}`);
  s = s.replace(oldText, newText);
  fs.writeFileSync(path, s);
}

replace(
  'netlify/functions/ask.js',
  "const { classifyAndHydrateMatter, mergeGovernanceFacts } = require('./lib/llmGovernance');",
  "const { classifyAndHydrateMatter, mergeGovernanceFacts } = require('./lib/llmGovernance');\nconst { caseReference } = require('./lib/caseReference');",
  'ask import'
);
replace(
  'netlify/functions/ask.js',
  "body: JSON.stringify({ success: true, caseId: data.id, triage, message: triage.recommended_next_step })",
  "body: JSON.stringify({ success: true, caseId: data.id, caseReference: caseReference(data.id, data.created_at), triage, message: triage.recommended_next_step })",
  'triage response'
);
replace(
  'netlify/functions/ask.js',
  "body: JSON.stringify({ pitch: scorecard.advisory_note, hasMerit: scorecard.wp_eligible, caseId: data.id, scorecard, governance: caseFacts.llm_governance, whatsapp })",
  "body: JSON.stringify({ pitch: scorecard.advisory_note, hasMerit: scorecard.wp_eligible, caseId: data.id, caseReference: caseReference(data.id, data.created_at), scorecard, governance: caseFacts.llm_governance, whatsapp })",
  'evaluate response'
);

replace(
  'netlify/functions/lib/whatsappProductionConversation.js',
  "const baseConversation = require('./whatsappConversation');",
  "const baseConversation = require('./whatsappConversation');\nconst { caseReference } = require('./caseReference');",
  'whatsapp reference import'
);
replace(
  'netlify/functions/lib/whatsappProductionConversation.js',
  "  return COMPLETION_MESSAGE;\n}",
  "  const reference = evaluation.caseReference || caseReference(evaluation.caseId);\n  return `${COMPLETION_MESSAGE}\\n\\nYour VRS case reference is ${reference}. Please keep this reference and quote it if you contact VRS through another channel.`;\n}",
  'whatsapp completion reference'
);
replace(
  'netlify/functions/lib/whatsappProductionConversation.js',
  "    return COMPLETION_MESSAGE;\n  }",
  "    const reference = caseReference(conversation?.case_id);\n    return reference ? `${COMPLETION_MESSAGE}\\n\\nYour VRS case reference is ${reference}. Please quote it if you contact VRS through another channel.` : COMPLETION_MESSAGE;\n  }",
  'legacy whatsapp completion reference'
);

replace(
  'admin-workstation.html',
  "<div class=\"case-id\">Case ID: ' + esc(c.id) + ' · Updated ' + esc(date(c.updated_at)) + '</div>",
  "<div class=\"case-id\"><strong>Reference: ' + esc(f.case_reference || c.case_reference || '—') + '</strong> · Internal ID: ' + esc(c.id) + ' · Updated ' + esc(date(c.updated_at)) + '</div>",
  'admin case header'
);
replace(
  'admin-workstation.html',
  "return [f.client_name,c.client_name,f.employer_name,f.incident_description,c.issue_summary,ed.track,ed.merit_band].join(' ').toLowerCase().includes(search);",
  "return [f.case_reference,c.case_reference,c.id,f.client_name,c.client_name,f.contact_info,c.contact_info,f.employer_name,f.employer_contact_details,f.incident_description,c.issue_summary,ed.track,ed.merit_band].join(' ').toLowerCase().includes(search);",
  'admin search fields'
);
replace(
  'admin-workstation.html',
  "<div class=\"case-name\">' + esc(name) + '</div>' + statusBadge(st) + '</div><div class=\"case-summary\">",
  "<div><div class=\"case-name\">' + esc(name) + '</div><div class=\"case-id\">' + esc(f.case_reference || c.case_reference || '') + '</div></div>' + statusBadge(st) + '</div><div class=\"case-summary\">",
  'admin card reference'
);

replace(
  'index.html',
  "            activeCaseId = data.caseId;\n            appendMessage(data.pitch, \"bot\");",
  "            activeCaseId = data.caseId;\n            appendMessage(data.pitch, \"bot\");\n            if (data.caseReference) appendMessage(`Your VRS case reference is ${data.caseReference}. Please keep this and quote it if you contact VRS through another channel.`, \"bot\");",
  'web evaluation reference'
);
replace(
  'index.html',
  "                activeCaseId = data.caseId;\n                console.log(\"Jurisdiction triage captured:\", data.caseId);",
  "                activeCaseId = data.caseId;\n                if (data.caseReference) appendMessage(`Your VRS case reference is ${data.caseReference}. Please keep this and quote it if you contact VRS through another channel.`, \"bot\");\n                console.log(\"Jurisdiction triage captured:\", data.caseId);",
  'web triage reference'
);

console.log('Case reference rollout applied');
