const moment = require('moment');

function parseDateFromFilename(basename, userFormat) {
  try {
    const candidates = [];
    if (userFormat && String(userFormat).trim()) candidates.push(String(userFormat).trim());
    candidates.push(moment.ISO_8601, 'YYYY-MM-DD', 'YYYY_MM_DD', 'YYYYMMDD');

    const whole = moment(basename, candidates, true);
    if (whole && whole.isValid()) return whole.format('YYYY-MM-DD');

    const dateTokenMatch = basename.match(/(\d{4}[-_/]\d{2}[-_/]\d{2}|\d{8})$/);
    if (dateTokenMatch) {
      const token = dateTokenMatch[1];
      const parsed = moment(token, candidates, true);
      if (parsed && parsed.isValid()) return parsed.format('YYYY-MM-DD');
      const fallback = moment(token, ['YYYY-MM-DD', 'YYYYMMDD'], true);
      if (fallback && fallback.isValid()) return fallback.format('YYYY-MM-DD');
    }
    return null;
  } catch (e) {
    return null;
  }
}

const tests = [
  { name: 'ISO date only', basename: '2026-03-18', format: undefined, expect: '2026-03-18' },
  { name: 'Compact date', basename: '20260318', format: undefined, expect: '2026-03-18' },
  { name: 'Verbose user format', basename: 'Wednesday, March 18th 2026', format: 'dddd, MMMM Do YYYY', expect: '2026-03-18' },
  { name: 'Title with trailing date', basename: 'Meeting Notes 2026-03-18', format: undefined, expect: '2026-03-18' },
  { name: 'Different separator', basename: 'Meeting_2026_03_18', format: undefined, expect: '2026-03-18' },
  { name: 'Non-date', basename: 'Notes about project', format: undefined, expect: null },
];

for (const t of tests) {
  const out = parseDateFromFilename(t.basename, t.format);
  console.log(`${t.name}: ${t.basename} -> ${out} ${out === t.expect ? 'OK' : 'FAIL (expected ' + t.expect + ')'}`);
}
