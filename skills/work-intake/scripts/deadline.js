const WEEKDAYS = new Map([
  ['一', 1], ['二', 2], ['三', 3], ['四', 4],
  ['五', 5], ['六', 6], ['日', 0], ['天', 0],
]);

function dateParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number.parseInt(part.value, 10)]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function addDays(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDateTimeToIso(local, timeZone) {
  const target = Date.UTC(
    local.year, local.month - 1, local.day,
    local.hour, local.minute, 0, 0,
  );
  let candidate = target;
  for (let index = 0; index < 4; index += 1) {
    const observed = dateParts(new Date(candidate), timeZone);
    const observedWallClock = Date.UTC(
      observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second, 0,
    );
    const correction = target - observedWallClock;
    candidate += correction;
    if (correction === 0) break;
  }
  const resolved = dateParts(new Date(candidate), timeZone);
  if (resolved.year !== local.year || resolved.month !== local.month
    || resolved.day !== local.day || resolved.hour !== local.hour
    || resolved.minute !== local.minute) {
    throw new TypeError(`deadline is not a valid local time in ${timeZone}`);
  }
  return new Date(candidate).toISOString();
}

function resolveCalendarDate(text, base) {
  if (text.includes('后天')) return addDays(base, 2);
  if (text.includes('明天')) return addDays(base, 1);
  if (text.includes('今天')) return addDays(base, 0);

  const explicit = text.match(/(?:(20\d{2})[年\-/])?(\d{1,2})[月\-/](\d{1,2})日?/u);
  if (explicit) {
    let year = explicit[1] ? Number(explicit[1]) : base.year;
    const month = Number(explicit[2]);
    const day = Number(explicit[3]);
    if (!explicit[1] && (month < base.month || (month === base.month && day < base.day))) {
      year += 1;
    }
    const checked = new Date(Date.UTC(year, month - 1, day));
    if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month
      || checked.getUTCDate() !== day) {
      throw new TypeError('deadline contains an invalid calendar date');
    }
    return { year, month, day };
  }

  const weekday = text.match(/(本周|下周|周)([一二三四五六日天])/u);
  if (!weekday) return null;
  const target = WEEKDAYS.get(weekday[2]);
  const current = new Date(Date.UTC(base.year, base.month - 1, base.day)).getUTCDay();
  const currentFromMonday = (current + 6) % 7;
  const targetFromMonday = (target + 6) % 7;
  let days;
  if (weekday[1] === '下周') days = 7 - currentFromMonday + targetFromMonday;
  else if (weekday[1] === '本周') days = targetFromMonday - currentFromMonday;
  else days = (target - current + 7) % 7;
  return addDays(base, days);
}

function resolveClock(text) {
  const match = text.match(/(上午|中午|下午|晚上|凌晨)?(\d{1,2})(?::|点)(\d{0,2})分?/u);
  if (!match) return { hour: 18, minute: 0 };
  const period = match[1] || null;
  let hour = Number(match[2]);
  const minute = match[3] === '' ? 0 : Number(match[3]);
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
  if (period === '凌晨' && hour === 12) hour = 0;
  if (period === '中午' && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) throw new TypeError('deadline contains an invalid time');
  return { hour, minute };
}

export function resolveDueAt({ dueText, receivedAt, timeZone }) {
  if (dueText === null || dueText === undefined) return null;
  if (typeof dueText !== 'string' || dueText.trim() === '') {
    throw new TypeError('dueText must be a non-empty string');
  }
  const received = new Date(receivedAt);
  if (!receivedAt || Number.isNaN(received.getTime())) {
    throw new TypeError('receivedAt is required to resolve a relative deadline');
  }
  const base = dateParts(received, timeZone);
  const calendar = resolveCalendarDate(dueText, base);
  if (!calendar) throw new TypeError(`unsupported deadline: ${dueText}`);
  return localDateTimeToIso({ ...calendar, ...resolveClock(dueText) }, timeZone);
}
