function determineProductRoute(facts = {}) {
  const track = String(facts.track || '').toUpperCase();
  const employmentStatus = String(facts.employment_status || '').toUpperCase();
  const advisoryTopic = facts.ancillary_topic || facts.advisory_topic || null;
  const wpEligible = facts.wp_eligible === true;

  if (employmentStatus === 'UIF' || track === 'UIF') {
    return {
      route: 'UIF',
      product_code: null,
      product_label: null,
      payment_allowed: false,
      wp_letter_allowed: false,
      reason: 'UIF matters follow the Master Guide UIF route and do not receive a WP letter.'
    };
  }

  if (track === 'ANC' || advisoryTopic || ['PDA', 'ULP'].includes(track)) {
    return {
      route: 'ANCILLARY_OR_ADVISORY',
      product_code: null,
      product_label: null,
      payment_allowed: false,
      wp_letter_allowed: false,
      reason: 'Ancillary/advisory matters follow the Master Guide route and do not receive a WP letter through this product flow.'
    };
  }

  if (wpEligible) {
    return {
      route: 'WP_LETTER',
      product_code: 'WP_LETTER',
      product_label: 'Without Prejudice Letter',
      payment_allowed: true,
      wp_letter_allowed: true,
      reason: 'The deterministic assessment permits the WP letter product for this track.'
    };
  }

  return {
    route: 'NO_PRODUCT',
    product_code: null,
    product_label: null,
    payment_allowed: false,
    wp_letter_allowed: false,
    reason: 'No payable letter product is available for the current deterministic outcome.'
  };
}

function canRequestPaymentForWp(facts = {}) {
  const route = determineProductRoute(facts);
  return route.payment_allowed === true && route.product_code === 'WP_LETTER';
}

module.exports = { determineProductRoute, canRequestPaymentForWp };
