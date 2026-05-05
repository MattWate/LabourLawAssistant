function determineRecommendation(substantiveScore, proceduralScore, options = {}) {
  const track = options.track || null;

  if (track === 'ANC') {
    return {
      band: 'LOW',
      wpEligible: false,
      wpType: null,
      recommendation: 'Ancillary advisory only. Prepare the appropriate advisory note or preparation pack. Do not offer a Without Prejudice demand letter.'
    };
  }

  if (substantiveScore >= 7 && proceduralScore >= 7) {
    return {
      band: 'HIGH',
      wpEligible: true,
      wpType: 'FULL',
      recommendation: 'Full WP demand letter, settlement-orientated, attorney priority review.'
    };
  }

  if (substantiveScore >= 7 && proceduralScore >= 4) {
    return {
      band: 'MEDIUM-HIGH',
      wpEligible: true,
      wpType: 'SUBSTANTIVE_EMPHASIS',
      recommendation: 'WP demand letter with substantive emphasis, attorney review.'
    };
  }

  if (substantiveScore >= 7 && proceduralScore < 4) {
    return {
      band: 'MEDIUM-HIGH',
      wpEligible: true,
      wpType: 'SUBSTANTIVE_ONLY',
      recommendation: 'WP demand letter substantive-only; case turns on whether employer can prove procedural compliance.'
    };
  }

  if (substantiveScore >= 4 && proceduralScore >= 7) {
    return {
      band: 'MEDIUM-HIGH',
      wpEligible: true,
      wpType: 'PROCEDURAL_ONLY',
      recommendation: 'Procedural-Only WP demand letter; aim is settlement or mutual separation. Attorney review.'
    };
  }

  if (substantiveScore >= 4 && proceduralScore >= 4) {
    return {
      band: 'MEDIUM',
      wpEligible: true,
      wpType: 'ADVISORY_CAVEAT',
      recommendation: 'Advisory note. WP letter offered with attorney advisory caveat. Consider negotiated separation.'
    };
  }

  if (substantiveScore >= 4 && proceduralScore < 4) {
    return {
      band: 'LOW-MEDIUM',
      wpEligible: false,
      wpType: null,
      recommendation: 'Advisory note only. Recommend internal appeal or grievance process. Reference letter / mutual separation track.'
    };
  }

  if (substantiveScore < 4 && proceduralScore >= 7) {
    return {
      band: 'MEDIUM',
      wpEligible: true,
      wpType: 'PROCEDURAL_ONLY',
      recommendation: 'Procedural-Only WP letter. Strong settlement leverage despite weak substantive position.'
    };
  }

  if (substantiveScore < 4 && proceduralScore >= 4) {
    return {
      band: 'LOW',
      wpEligible: false,
      wpType: null,
      recommendation: 'Advisory note. Recommend mutual separation / reference letter request. No demand letter.'
    };
  }

  return {
    band: 'NO MERIT',
    wpEligible: false,
    wpType: null,
    recommendation: 'Advisory note. No WP letter. Explain legal position. Offer alternative pathways.'
  };
}

module.exports = { determineRecommendation };
