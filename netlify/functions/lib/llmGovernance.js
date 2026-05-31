const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
const ANTHROPIC_VERSION = '2023-06-01';

const TRACK_TO_CATEGORY = {
  'UD-MISCONDUCT': 'Dismissed',
  'UD-POOR_PERFORMANCE': 'Dismissed',
  'UD-INCAPACITY': 'Dismissed',
  'UD-RETRENCHMENT': 'Dismissed',
  CD: 'Resigned',
  AUD: 'Discrimination',
  ULP: 'Advisory',
  PDA: 'Advisory',
  ANC: 'Advisory'
};

const TRACK_TO_REASON = {
  'UD-MISCONDUCT': 'Misconduct',
  'UD-POOR_PERFORMANCE': 'Poor Performance',
  'UD-INCAPACITY': 'Incapacity',
  'UD-RETRENCHMENT': 'Retrenchment'
};

const ADVISORY_TOPIC_MAP = {
  E1_WARNING: 'Warning',
  E2_GRIEVANCE: 'Grievance',
  E3_HEARING_PREP: 'Hearing Prep',
  E4_BCEA_QUERY: 'BCEA query',
  E5_REFERENCE_DEMAND: 'Reference letter',
  E6_PAY_DISPUTE: 'Pay Issue',
  WARNING: 'Warning',
  SUSPENSION: 'Suspension',
  GRIEVANCE: 'Grievance',
  PAY_DISPUTE: 'Pay Issue',
  HEARING_PREP: 'Hearing Prep'
};

const OVERRIDE_ALIASES = {
  WHISTLEBLOWER: 'PROTECTED_DISCLOSURE',
  PROTECTED_DISCLOSURE: 'PROTECTED_DISCLOSURE',
  SUSPENSION_WITHOUT_PAY: 'SUSPENSION_WITHOUT_PAY',
  UNION_ACTIVITY: 'UNION_ACTIVITY',
  NON_PAYMENT_OF_SALARY: 'SUSTAINED_NON_PAYMENT',
  SUSTAINED_NON_PAYMENT: 'SUSTAINED_NON_PAYMENT',
  SICK_LEAVE_OR_HIV: 'HIV_OR_SICK_LEAVE',
  HIV_OR_SICK_LEAVE: 'HIV_OR_SICK_LEAVE',
  HAZARDOUS_WORK_REFUSAL: 'HAZARDOUS_WORK_REFUSAL',
  PROTECTED_GROUND_DISCRIMINATION: 'PROTECTED_GROUND_DISCRIMINATION',
  SHAM_RETRENCHMENT: 'SHAM_RETRENCHMENT',
  PREGNANCY: 'PREGNANCY'
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function parseJsonOnly(text = '') {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw firstError;
  }
}

function normaliseTrack(track) {
  const value = String(track || '').trim().toUpperCase().replace(/\s+/g, '_');
  const map = {
    'UD_MISCONDUCT': 'UD-MISCONDUCT',
    'UD-CONDUCT': 'UD-MISCONDUCT',
    'UD_CONDUCT': 'UD-MISCONDUCT',
    'UD_POOR_PERFORMANCE': 'UD-POOR_PERFORMANCE',
    'UD-POORPERF': 'UD-POOR_PERFORMANCE',
    'UD_POORPERF': 'UD-POOR_PERFORMANCE',
    'UD_INCAPACITY': 'UD-INCAPACITY',
    'UD_RETRENCH': 'UD-RETRENCHMENT',
    'UD_RETRENCHMENT': 'UD-RETRENCHMENT',
    'CONSTRUCTIVE_DISMISSAL': 'CD',
    'AUTOMATICALLY_UNFAIR_DISMISSAL': 'AUD',
    'UNFAIR_LABOUR_PRACTICE': 'ULP',
    'PRE_DISMISSAL_ADVISORY': 'PDA',
    'ANCILLARY': 'ANC',
    'ANCILLARY_ADVISORY': 'ANC'
  };
  return map[value] || (['UD-MISCONDUCT', 'UD-POOR_PERFORMANCE', 'UD-INCAPACITY', 'UD-RETRENCHMENT', 'CD', 'AUD', 'ULP', 'PDA', 'ANC'].includes(value) ? value : null);
}

function normaliseOverrideFlags(flags = []) {
  if (!Array.isArray(flags)) return [];
  return [...new Set(flags.map(flag => OVERRIDE_ALIASES[String(flag || '').trim().toUpperCase()]).filter(Boolean))];
}

function boolOrNull(value) {
  if (value === true || value === false || value === null) return value;
  const text = String(value || '').trim().toLowerCase();
  if (['true', 'yes', 'y'].includes(text)) return true;
  if (['false', 'no', 'n'].includes(text)) return false;
  return null;
}

function cleanHydratedFacts(input = {}) {
  const allowed = [
    'incident_date', 'dismissal_reason_type', 'conduct_admission', 'length_of_service',
    'gross_monthly_salary', 'hearing_held', 'paid_suspension', 'prior_warnings',
    'pip_given', 'pip_duration', 'narrative', 'employment_status', 'advisory_topic',
    'proc_notice', 'proc_rep', 'proc_chair', 'proc_consultation', 'protected_ground',
    'performance_standards_communicated', 'training_provided', 'performance_control',
    'team_meeting_standards', 'retrenchment_consultation', 's189_notice',
    'selection_criteria_objective', 'retrenchment_alternatives', 'severance_pay',
    'role_refilled'
  ];

  const hydrated = {};
  allowed.forEach(key => {
    if (!(key in input)) return;
    const value = cleanString(input[key]);
    if (value === undefined || value === '') return;
    hydrated[key] = value;
  });

  ['hearing_held', 'paid_suspension', 'pip_given', 'proc_notice', 'proc_rep', 'proc_chair', 'proc_consultation', 's189_notice', 'selection_criteria_objective', 'retrenchment_alternatives'].forEach(key => {
    if (key in hydrated) hydrated[key] = boolOrNull(hydrated[key]);
  });

  if (hydrated.narrative && !hydrated.incident_description) {
    hydrated.incident_description = hydrated.narrative;
    delete hydrated.narrative;
  }

  if (hydrated.gross_monthly_salary !== undefined) {
    hydrated.salary = hydrated.gross_monthly_salary;
  }
  if (hydrated.length_of_service !== undefined) {
    hydrated.tenure = hydrated.length_of_service;
  }

  return hydrated;
}

function toCompatibilityShape(governance = {}) {
  const primaryTrack = governance.primary_track || null;
  const hydrated = governance.hydrated_facts || {};
  const advisoryTopic = governance.advisory_topic || hydrated.advisory_topic || null;
  const category = TRACK_TO_CATEGORY[primaryTrack] || hydrated.employment_status || 'Ambiguous';
  return {
    category,
    dismissal_reason_type: TRACK_TO_REASON[primaryTrack] || hydrated.dismissal_reason_type || null,
    advisory_topic: ADVISORY_TOPIC_MAP[advisoryTopic] || advisoryTopic || null,
    confidence: typeof governance.confidence === 'number' ? governance.confidence : 0
  };
}

function normaliseGovernance(raw = {}, source = 'claude') {
  const primaryTrack = normaliseTrack(raw.primary_track);
  const secondaryTrack = normaliseTrack(raw.secondary_track);
  const advisoryTopic = cleanString(raw.advisory_topic) || null;
  const overrideFlags = normaliseOverrideFlags(raw.override_flags);
  const hydratedFacts = cleanHydratedFacts(raw.hydrated_facts || raw.extracted_fields || raw.case_facts || {});

  if (primaryTrack) hydratedFacts.track = primaryTrack;
  if (secondaryTrack) hydratedFacts.secondary_track = secondaryTrack;
  if (advisoryTopic) {
    hydratedFacts.advisory_topic = ADVISORY_TOPIC_MAP[advisoryTopic] || advisoryTopic;
    hydratedFacts.ancillary_topic = hydratedFacts.advisory_topic;
  }
  if (overrideFlags.length) hydratedFacts.override_flags = overrideFlags;

  const normalised = {
    source,
    ok: Boolean(primaryTrack || Object.keys(hydratedFacts).length || overrideFlags.length),
    primary_track: primaryTrack,
    secondary_track: secondaryTrack,
    advisory_topic: advisoryTopic,
    override_flags: overrideFlags,
    hydrated_facts: hydratedFacts,
    confidence: Number(raw.confidence || 0),
    confidence_per_field: raw.confidence_per_field || {},
    reasoning: cleanString(raw.reasoning) || null,
    raw_response: raw
  };

  return { ...normalised, compatibility: toCompatibilityShape(normalised) };
}

function buildGovernancePrompt({ narrative = '', existingFacts = {} }) {
  const safeFacts = JSON.stringify(existingFacts || {}, null, 2);
  return `You are the governance intake layer of the Justine Labour Law Assistant for South African labour-law matters.

Your job is to classify the matter and hydrate structured case facts from the user's narrative. You do not draft advice. You do not make the final decision. You prepare structured facts for a deterministic scoring engine.

Return ONLY valid JSON. No markdown fences. No commentary.

Primary track enum:
- UD-MISCONDUCT
- UD-POOR_PERFORMANCE
- UD-INCAPACITY
- UD-RETRENCHMENT
- CD
- AUD
- ULP
- PDA
- ANC

ANC advisory_topic enum:
- E1_WARNING
- E2_GRIEVANCE
- E3_HEARING_PREP
- E4_BCEA_QUERY
- E5_REFERENCE_DEMAND
- E6_PAY_DISPUTE

Override flags enum:
- PREGNANCY
- WHISTLEBLOWER
- SUSPENSION_WITHOUT_PAY
- UNION_ACTIVITY
- NON_PAYMENT_OF_SALARY
- SICK_LEAVE_OR_HIV
- HAZARDOUS_WORK_REFUSAL
- PROTECTED_GROUND_DISCRIMINATION
- SHAM_RETRENCHMENT

Important rules:
- If the user is still employed and describes a warning, grievance, suspension or pay dispute, primary_track is usually ANC unless the narrative clearly fits PDA or ULP.
- "final written warning" maps to advisory_topic E1_WARNING.
- "suspended without pay" or "suspension without pay" must set override_flags to include SUSPENSION_WITHOUT_PAY and hydrated_facts.paid_suspension to false.
- If the narrative says there was no hearing, set hydrated_facts.hearing_held to false.
- If a fact is not clear at confidence >= 0.7, set it to null or omit it.
- Adjacent statutes such as OHS Act protected-role analysis may be flagged in reasoning but must not become a special track.
- Preserve the user's narrative once. Do not duplicate it.

Return this JSON shape exactly:
{
  "primary_track": "ANC",
  "secondary_track": null,
  "advisory_topic": "E1_WARNING",
  "override_flags": [],
  "confidence": 0.0,
  "reasoning": "one concise sentence",
  "hydrated_facts": {
    "incident_date": null,
    "dismissal_reason_type": null,
    "conduct_admission": null,
    "length_of_service": null,
    "gross_monthly_salary": null,
    "hearing_held": null,
    "paid_suspension": null,
    "prior_warnings": null,
    "pip_given": null,
    "pip_duration": null,
    "narrative": "the user's intake narrative if useful",
    "employment_status": null,
    "advisory_topic": null
  },
  "confidence_per_field": {}
}

Existing facts already captured:
${safeFacts}

User intake narrative:
${narrative}`;
}

async function callClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1800,
      temperature: 0.2,
      system: 'Return valid JSON only. You are a legal intake classification and data extraction layer, not a legal adviser.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude governance call failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = (data.content || []).map(item => item.text || '').join('\n').trim();
  return parseJsonOnly(text);
}

async function classifyAndHydrateMatter({ narrative = '', existingFacts = {} }) {
  const prompt = buildGovernancePrompt({ narrative, existingFacts });
  const startedAt = new Date().toISOString();

  try {
    const raw = await callClaude(prompt);
    const governance = normaliseGovernance(raw, 'claude');
    governance.log = {
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      temperature: 0.2,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status: 'success',
      input_summary: String(narrative || '').slice(0, 500),
      output: governance.raw_response
    };
    return governance;
  } catch (error) {
    return {
      source: 'fallback',
      ok: false,
      primary_track: null,
      secondary_track: null,
      advisory_topic: null,
      override_flags: [],
      hydrated_facts: {},
      confidence: 0,
      confidence_per_field: {},
      reasoning: null,
      compatibility: { category: 'Ambiguous', dismissal_reason_type: null, advisory_topic: null, confidence: 0 },
      log: {
        provider: 'anthropic',
        model: CLAUDE_MODEL,
        temperature: 0.2,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        status: 'failed_or_not_configured',
        error: error.message,
        input_summary: String(narrative || '').slice(0, 500)
      }
    };
  }
}

function mergeGovernanceFacts(existingFacts = {}, governance = {}) {
  const hydrated = governance?.hydrated_facts || {};
  const merged = { ...existingFacts };

  Object.entries(hydrated).forEach(([key, value]) => {
    if (value === undefined || value === '' || value === null) return;
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') {
      merged[key] = value;
    }
  });

  if (governance.primary_track && !merged.track) merged.track = governance.primary_track;
  if (governance.secondary_track && !merged.secondary_track) merged.secondary_track = governance.secondary_track;
  if (governance.advisory_topic && !merged.advisory_topic) {
    merged.advisory_topic = ADVISORY_TOPIC_MAP[governance.advisory_topic] || governance.advisory_topic;
    merged.ancillary_topic = merged.advisory_topic;
  }

  const flags = [...(Array.isArray(merged.override_flags) ? merged.override_flags : []), ...(governance.override_flags || [])];
  if (flags.length) merged.override_flags = [...new Set(flags)];

  merged.llm_governance = {
    source: governance.source,
    ok: governance.ok,
    primary_track: governance.primary_track,
    secondary_track: governance.secondary_track,
    advisory_topic: governance.advisory_topic,
    override_flags: governance.override_flags,
    confidence: governance.confidence,
    confidence_per_field: governance.confidence_per_field,
    reasoning: governance.reasoning
  };

  merged.llm_call_logs = [...(Array.isArray(existingFacts.llm_call_logs) ? existingFacts.llm_call_logs : []), governance.log].filter(Boolean);

  return merged;
}

module.exports = {
  classifyAndHydrateMatter,
  mergeGovernanceFacts,
  normaliseGovernance,
  toCompatibilityShape
};