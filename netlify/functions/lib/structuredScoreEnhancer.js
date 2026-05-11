function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

function hasAny(value, terms) {
  const text = clean(value);
  return terms.some(term => text.includes(term));
}

function add(breakdown, channel, points, label, legalHook) {
  if (!points) return;
  breakdown.push({ channel, points, label, legalHook });
}

function clamp(value) {
  return Math.max(0, Math.min(10, Math.round((Number(value) || 0) * 10) / 10));
}

function enhanceRetrenchmentScore(facts = {}, scorecard = {}) {
  if (scorecard.track !== 'UD-RETRENCHMENT') return scorecard;

  const breakdown = Array.isArray(scorecard.scoring_breakdown) ? [...scorecard.scoring_breakdown] : [];
  let substantive = Number(scorecard.substantive_score ?? 3);
  let procedural = Number(scorecard.procedural_score ?? 3);

  const headcount = clean(facts.retrenchment_headcount);
  const s189Notice = facts.s189_notice;
  const consultation = clean(facts.retrenchment_consultation || facts.proc_consultation);
  const selection = facts.selection_criteria_objective;
  const alternatives = facts.retrenchment_alternatives ?? facts.retrenchment_alternatives_offered;
  const severance = clean(facts.severance_pay);
  const reason = clean(facts.operational_reason_plausible);
  const refilled = clean(facts.role_refilled);
  const story = `${facts.initial_query || ''} ${facts.incident_description || ''}`;

  if (headcount.includes('10+')) {
    add(breakdown, 'procedural', 0, 'Large-scale retrenchment indicator captured for attorney review', 'LRA s189A');
  }

  if (s189Notice === false || clean(s189Notice) === 'false' || clean(s189Notice) === 'no') {
    procedural += 4;
    add(breakdown, 'procedural', 4, 'No written s189(3) notice appears to have been issued', 'LRA s189(3)');
  } else if (clean(s189Notice).includes('unsure')) {
    procedural += 1;
    add(breakdown, 'procedural', 1, 's189(3) notice is unclear and requires attorney review', 'LRA s189(3)');
  }

  if (consultation.includes('no consultation')) {
    procedural += 3;
    add(breakdown, 'procedural', 3, 'No meaningful consultation before final decision', 'LRA s189');
  } else if (consultation.includes('brief')) {
    procedural += 2;
    add(breakdown, 'procedural', 2, 'Consultation appears brief or insufficient', 'LRA s189');
  }

  if (selection === false || clean(selection) === 'false' || clean(selection) === 'no') {
    substantive += 3;
    add(breakdown, 'substantive', 3, 'Selection criteria may be unfair or undisclosed', 'LRA s189');
  } else if (clean(selection).includes('unclear')) {
    substantive += 1;
    add(breakdown, 'substantive', 1, 'Selection criteria are unclear', 'LRA s189');
  }

  if (alternatives === false || clean(alternatives) === 'false' || clean(alternatives) === 'no') {
    substantive += 2;
    add(breakdown, 'substantive', 2, 'No alternatives such as redeployment or short time were offered', 'LRA s189');
  }

  if (severance.includes('less')) {
    substantive += 1;
    add(breakdown, 'substantive', 1, 'Severance appears below one week per completed year of service', 'BCEA s41');
  } else if (severance === 'no') {
    substantive += 2;
    add(breakdown, 'substantive', 2, 'No severance pay appears to have been offered', 'BCEA s41');
  }

  if (reason.includes('doubt')) {
    substantive += 2;
    add(breakdown, 'substantive', 2, 'Operational reason appears doubtful', 'LRA s189');
  }

  if (refilled === 'yes' || hasAny(story, ['role refilled', 'replaced me', 'same role advertised', 'position refilled'])) {
    substantive += 3;
    add(breakdown, 'substantive', 3, 'Role appears to have been refilled or replaced, suggesting possible sham retrenchment', 'LRA s189');
  }

  scorecard.substantive_score = clamp(substantive);
  scorecard.procedural_score = clamp(procedural);
  scorecard.scoring_breakdown = breakdown;

  return scorecard;
}

function enhanceStructuredScore(facts = {}, scorecard = {}) {
  if (scorecard.track === 'UD-RETRENCHMENT') return enhanceRetrenchmentScore(facts, scorecard);
  return scorecard;
}

module.exports = { enhanceStructuredScore };
