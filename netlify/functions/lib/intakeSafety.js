const { validateAndNormaliseDate } = require('./dateValidation');

const CRITICAL_STATES = new Set([
  'FIRED_DATE','RESIGN_DATE','DISC_STATUS'
]);

const OPTIONAL_STATES = new Set([
  'ADDRESSEE_NAME','ADDRESSEE_POSITION','COMPANY_CONTACT'
]);

const CONTACT_STATES = new Set([
  'CONTACT_NAME','CONTACT_EMAIL','CONTACT_PHONE',
  'CLIENT_NAME','CLIENT_EMAIL','CLIENT_PHONE'
]);

function deadlineStatus(facts = {}, now = new Date()) {
  const track = String(facts.track || facts.primary_track || '').toUpperCase();
  const statusText = String(facts.disc_status || facts.employment_status || facts.category || '').toLowerCase();
  const dismissalWindowApplies =
    track.startsWith('UD-') ||
    track === 'CD' ||
    (track === 'AUD' && (statusText.includes('dismiss') || statusText.includes('fire')));

  if (!dismissalWindowApplies) {
    return { status:'NOT_APPLICABLE', daysElapsed:null, daysRemaining:null, daysOverdue:null };
  }

  const dateValue = facts.incident_date || facts.dismissal_date || facts.resignation_date;
  if (!dateValue) {
    return { status:'UNKNOWN', reason:'missing_date', daysElapsed:null, daysRemaining:null, daysOverdue:null };
  }

  const parsed = validateAndNormaliseDate(dateValue, { allowFuture:false, now });
  if (!parsed.ok) {
    return { status:'UNKNOWN', reason:parsed.reason, daysElapsed:null, daysRemaining:null, daysOverdue:null };
  }

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysElapsed = Math.floor((todayUtc - parsed.date.getTime()) / 86400000);

  if (daysElapsed <= 30) {
    return {
      status:'WITHIN_WINDOW',
      eventDate:parsed.iso,
      daysElapsed,
      daysRemaining:30 - daysElapsed,
      daysOverdue:0
    };
  }

  return {
    status:'LAPSED-CONDONATION',
    eventDate:parsed.iso,
    daysElapsed,
    daysRemaining:null,
    daysOverdue:daysElapsed - 30
  };
}

function deadlineMessage(status = {}) {
  if (status.status === 'LAPSED-CONDONATION') {
    return `Important: based on the date you gave us, the ordinary 30-day CCMA referral period appears to have passed by ${status.daysOverdue} days. Condonation may be required, so this needs urgent review.`;
  }
  if (status.status === 'WITHIN_WINDOW' && Number(status.daysRemaining) <= 7) {
    return `Important: based on the date you gave us, there are only ${status.daysRemaining} days left in the ordinary 30-day CCMA referral period. Do not wait for settlement discussions before protecting the deadline.`;
  }
  return null;
}

function promptPriority(state) {
  if (CONTACT_STATES.has(state)) return 'contact';
  if (CRITICAL_STATES.has(state)) return 'critical';
  if (OPTIONAL_STATES.has(state)) return 'optional';
  return 'normal';
}

function promptBudgetDecision({ state, count = 0, limit = 15 }) {
  const priority = promptPriority(state);
  if (priority === 'contact' || priority === 'critical') {
    return { allow:true, countAgainstBudget:false, priority };
  }
  if (priority === 'optional' && count >= Math.max(0, limit - 3)) {
    return { allow:false, countAgainstBudget:false, priority, reason:'optional_deferred_for_budget' };
  }
  if (count >= limit) {
    return { allow:false, countAgainstBudget:false, priority, reason:'prompt_budget_reached' };
  }
  return { allow:true, countAgainstBudget:true, priority };
}

function candidateDateFromGovernance({ value, narrative = '', confidence = 0 }) {
  if (!value) return null;
  const explicitYear = /\b(?:19|20)\d{2}\b/.test(String(narrative || ''));
  return {
    value,
    confidence:Number(confidence || 0),
    explicit_year_in_source:explicitYear,
    confirmed:false,
    usable_as_legal_date:false
  };
}

module.exports = {
  deadlineStatus,
  deadlineMessage,
  promptPriority,
  promptBudgetDecision,
  candidateDateFromGovernance,
  CRITICAL_STATES,
  OPTIONAL_STATES,
  CONTACT_STATES
};
