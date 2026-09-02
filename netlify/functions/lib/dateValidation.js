function pad(value) {
  return String(value).padStart(2, '0');
}

function parseDateParts(value) {
  const text = String(value || '').trim();
  let year;
  let month;
  let day;

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (!match) {
      return { ok: false, reason: 'format', message: 'Please enter the date as DD/MM/YYYY, for example 17/08/2026.' };
    }
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  }

  if (year < 1900 || year > 2100) {
    return { ok: false, reason: 'year_range', message: 'That year does not look right. Please check the date and enter it as DD/MM/YYYY.' };
  }

  const utc = new Date(Date.UTC(year, month - 1, day));
  const isRealDate = utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
  if (!isRealDate) {
    return { ok: false, reason: 'calendar', message: 'I do not think that is a valid calendar date. Please check it and enter the date as DD/MM/YYYY.' };
  }

  return {
    ok: true,
    year,
    month,
    day,
    date: utc,
    iso: `${year}-${pad(month)}-${pad(day)}`
  };
}

function validateAndNormaliseDate(value, options = {}) {
  const parsed = parseDateParts(value);
  if (!parsed.ok) return parsed;

  const { allowFuture = false, now = new Date() } = options;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const valueUtc = parsed.date.getTime();

  if (!allowFuture && valueUtc > todayUtc) {
    return {
      ok: false,
      reason: 'future',
      message: 'That date appears to be in the future. Please check the date and try again.'
    };
  }

  return parsed;
}

module.exports = {
  parseDateParts,
  validateAndNormaliseDate
};
