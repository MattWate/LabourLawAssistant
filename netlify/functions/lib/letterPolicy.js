const TRACK_POLICIES = Object.freeze({
  'UD-MISCONDUCT': {
    settlement_categories: ['compensation_or_reinstatement','notice_pay_if_due','leave_pay_if_due','uif_ui19','certificate_of_service','reference','clean_record_if_applicable','confidentiality_non_disparagement']
  },
  'UD-POOR_PERFORMANCE': {
    settlement_categories: ['compensation_or_reinstatement','notice_pay_if_due','leave_pay_if_due','uif_ui19','certificate_of_service','reference','record_correction','confidentiality_non_disparagement']
  },
  'UD-INCAPACITY': {
    settlement_categories: ['compensation_or_reinstatement','notice_pay_if_due','leave_pay_if_due','uif_ui19','certificate_of_service','reference','benefit_fund_confirmation_if_applicable','confidentiality_non_disparagement']
  },
  'UD-RETRENCHMENT': {
    settlement_categories: ['severance_if_due','notice_pay_if_due','leave_pay_if_due','uif_ui19','certificate_of_service','reference','benefit_fund_confirmation_if_applicable','confidentiality_non_disparagement']
  },
  'CD': {
    settlement_categories: ['compensation_or_reinstatement','notice_pay_if_due','leave_pay_if_due','uif_ui19','certificate_of_service','reference','confidentiality_non_disparagement']
  },
  'AUD': {
    settlement_categories: ['compensation_or_reinstatement','notice_pay_if_due','leave_pay_if_due','uif_ui19','certificate_of_service','reference','clean_record_if_applicable','confidentiality_non_disparagement']
  },
  'ULP': {
    settlement_categories: ['withdraw_or_correct_action','restore_benefit_or_status','record_correction','compensation_if_applicable','confidentiality_non_disparagement']
  },
  'DISCIPLINARY': {
    settlement_categories: ['withdraw_or_amend_charges','fair_process_commitments','representation_and_preparation','record_correction_if_applicable','confidentiality_non_disparagement']
  },
  'ADVISORY': {
    settlement_categories: ['issue_specific_resolution','record_correction_if_applicable','reference_if_applicable','confidentiality_non_disparagement']
  }
});

const CATEGORY_GUIDANCE = Object.freeze({
  compensation_or_reinstatement: 'Consider compensation and/or reinstatement only where supported by the case strategy and client desired outcome.',
  notice_pay_if_due: 'Include notice pay only where legally/factually due; if cited, pair BCEA sections 37 and 38 correctly.',
  leave_pay_if_due: 'Include accrued leave pay only if supported by the case facts or clearly made conditional.',
  uif_ui19: 'Consider UIF/UI-19 documentation where employment has ended.',
  certificate_of_service: 'Consider a certificate of service where employment has ended.',
  reference: 'Consider an agreed neutral or positive reference where this matches the client desired outcome.',
  clean_record_if_applicable: 'Seek expungement/clean-record treatment only where an adverse disciplinary finding or outcome may exist; otherwise make it conditional.',
  record_correction: 'Seek correction/removal of adverse employment records where supported.',
  record_correction_if_applicable: 'Seek correction/removal of adverse disciplinary or employment records only where such records may exist.',
  confidentiality_non_disparagement: 'Use proportionate confidentiality and employee-side one-way non-disparagement unless mutuality is expressly authorised.',
  benefit_fund_confirmation_if_applicable: 'Consider pension/provident-fund confirmation or processing where applicable.',
  severance_if_due: 'For operational-requirements matters, address statutory/contractual severance where due.',
  withdraw_or_correct_action: 'For an unfair-labour-practice matter, target withdrawal, correction or reversal of the impugned workplace action.',
  restore_benefit_or_status: 'Where relevant, seek restoration of the affected benefit, status, opportunity or workplace position.',
  compensation_if_applicable: 'Include compensation only where the legal basis and case facts support it.',
  withdraw_or_amend_charges: 'For pre-dismissal disciplinary matters, consider withdrawal or narrowing of unsupported charges.',
  fair_process_commitments: 'Seek concrete procedural protections for any continuing disciplinary process.',
  representation_and_preparation: 'Where relevant, seek adequate preparation time and permitted representation.',
  issue_specific_resolution: 'Use a remedy tailored to the advisory issue rather than generic dismissal settlement terms.',
  reference_if_applicable: 'Include reference wording only where relevant to the dispute or client desired outcome.'
});

function canonicalTrack(track='') {
  const t=String(track||'').toUpperCase();
  if (TRACK_POLICIES[t]) return t;
  if (t.startsWith('UD-MISCONDUCT')) return 'UD-MISCONDUCT';
  if (t.startsWith('UD-POOR_PERFORMANCE')) return 'UD-POOR_PERFORMANCE';
  if (t.startsWith('UD-INCAPACITY')) return 'UD-INCAPACITY';
  if (t.startsWith('UD-RETRENCH')) return 'UD-RETRENCHMENT';
  if (t.includes('CONSTRUCTIVE')) return 'CD';
  if (t.includes('AUTOMATIC')) return 'AUD';
  if (t.includes('ULP') || t.includes('UNFAIR_LABOUR')) return 'ULP';
  if (t.includes('DISC')) return 'DISCIPLINARY';
  return 'ADVISORY';
}

function normaliseDeadlineStatus(value) {
  if (!value) return { status:'UNKNOWN', daysRemaining:null, daysOverdue:null };
  if (typeof value === 'string') return { status:String(value).toUpperCase(), daysRemaining:null, daysOverdue:null };
  return {
    status:String(value.status || 'UNKNOWN').toUpperCase(),
    daysRemaining:Number.isFinite(Number(value.daysRemaining)) ? Number(value.daysRemaining) : null,
    daysOverdue:Number.isFinite(Number(value.daysOverdue)) ? Number(value.daysOverdue) : null
  };
}

function responsePolicy(caseBrief={}) {
  const deadline=normaliseDeadlineStatus(caseBrief.ccma_deadline_status);
  if (deadline.status === 'LAPSED-CONDONATION') {
    return {
      business_days:3,
      rationale:'Urgent response because the ordinary referral period appears to have lapsed and condonation may be required.',
      statutory_deadline_independent:true
    };
  }
  if (deadline.status === 'WITHIN_WINDOW' && deadline.daysRemaining !== null && deadline.daysRemaining <= 7) {
    return {
      business_days:3,
      rationale:'Urgent response because the statutory referral window is close to expiry.',
      statutory_deadline_independent:true
    };
  }
  if (deadline.status === 'WITHIN_WINDOW') {
    return {
      business_days:5,
      rationale:'Prompt commercial response while preserving the independent statutory referral timetable.',
      statutory_deadline_independent:true
    };
  }
  return {
    business_days:7,
    rationale:'Standard commercial response period where no imminent statutory deadline is confirmed.',
    statutory_deadline_independent:true
  };
}

function timeBarPolicy(caseBrief={}) {
  const deadline=normaliseDeadlineStatus(caseBrief.ccma_deadline_status);
  if (deadline.status === 'LAPSED-CONDONATION') {
    return {
      disclose:true,
      level:'urgent_lapsed',
      instruction:'State that the ordinary referral period appears to have expired, condonation may be required, and settlement correspondence does not revive, extend or suspend the statutory referral period.'
    };
  }
  if (deadline.status === 'WITHIN_WINDOW' && deadline.daysRemaining !== null && deadline.daysRemaining <= 7) {
    return {
      disclose:true,
      level:'urgent_live',
      instruction:`State that approximately ${deadline.daysRemaining} day(s) remain in the identified referral window and that settlement discussions do not suspend that deadline.`
    };
  }
  if (deadline.status === 'WITHIN_WINDOW') {
    return {
      disclose:false,
      level:'live',
      instruction:'Do not clutter the outward letter with a deadline warning unless strategically useful, but do not imply that settlement discussions suspend the statutory referral period.'
    };
  }
  return {
    disclose:false,
    level:'unknown_or_not_applicable',
    instruction:'Do not invent a statutory deadline. If no reliable deadline is confirmed, omit a time-bar assertion.'
  };
}

function settlementPolicy(caseBrief={}) {
  const track=canonicalTrack(caseBrief.track);
  const base=TRACK_POLICIES[track] || TRACK_POLICIES.ADVISORY;
  return {
    track,
    desired_outcome:caseBrief.desired_outcome || null,
    categories:base.settlement_categories.map(id=>({id,guidance:CATEGORY_GUIDANCE[id]}))
  };
}

function buildLetterPolicy(caseBrief={}) {
  return {
    response:responsePolicy(caseBrief),
    time_bar:timeBarPolicy(caseBrief),
    settlement:settlementPolicy(caseBrief)
  };
}

function validateLetterPolicy({draft={},caseBrief={}}={}) {
  const policy=buildLetterPolicy(caseBrief);
  const structure=draft?.part_a_letter || draft || {};
  const text=JSON.stringify(structure);
  const lower=text.toLowerCase();
  const defects=[];

  if (/seven\s+calendar\s+days/i.test(text)) {
    defects.push('Do not use a fixed seven-calendar-day response period; use the deterministic business-day response policy.');
  }

  const dayMatch=text.match(/\b(\d{1,2})\s+(business|calendar)\s+days?\b/i);
  if (dayMatch) {
    const days=Number(dayMatch[1]);
    const kind=String(dayMatch[2]).toLowerCase();
    if (kind !== 'business' || days !== policy.response.business_days) {
      defects.push(`Response period must be ${policy.response.business_days} business days for this case policy, not ${dayMatch[0]}.`);
    }
  }

  if (policy.time_bar.disclose) {
    const mentionsDeadline=/referral|ccma|bargaining council|time.?bar|condonation|deadline/i.test(text);
    const saysIndependent=/does not (?:suspend|extend|stop|pause)|without affecting|independent of|protect.*deadline/i.test(text);
    if (!mentionsDeadline || !saysIndependent) {
      defects.push('Urgent time-bar policy requires an explicit referral-deadline warning and a statement that settlement correspondence does not suspend/extend the statutory deadline.');
    }
    if (policy.time_bar.level === 'urgent_lapsed' && !/condonation/i.test(text)) {
      defects.push('Where the referral period appears lapsed, the letter must flag that condonation may be required.');
    }
  }

  const track=policy.settlement.track;
  const terms=Array.isArray(structure.settlement_terms) ? structure.settlement_terms.join(' ').toLowerCase() : '';
  if (track === 'UD-RETRENCHMENT' && terms && !/severance/.test(terms)) {
    defects.push('Operational-requirements settlement terms should address severance where due or state the condition clearly.');
  }
  if (track === 'DISCIPLINARY' && /severance|uif|ui-19|certificate of service/.test(terms)) {
    defects.push('Pre-dismissal disciplinary settlement terms must not default to termination remedies unless the case facts expressly support them.');
  }
  if (track === 'ULP' && /severance/.test(terms)) {
    defects.push('Unfair-labour-practice settlement terms must be issue-specific and should not default to retrenchment severance.');
  }

  return {ok:defects.length===0,defects:[...new Set(defects)],policy};
}

module.exports={
  TRACK_POLICIES,
  canonicalTrack,
  responsePolicy,
  timeBarPolicy,
  settlementPolicy,
  buildLetterPolicy,
  validateLetterPolicy
};
