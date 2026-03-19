// Shared utility: parse dates from filenames using the user's daily-note format first,
// then fall back to ISO / common formats and simple regexes.
export function parseDateFromFilename(basename: string, userFormat?: string): any | null {
  try {
    const m = (window as any).moment;
    if (!m) return null;

    const candidates: any[] = [];
    if (userFormat && String(userFormat).trim()) candidates.push(String(userFormat).trim());
    // Accept ISO, then common canonical formats
    candidates.push((m as any).ISO_8601, 'YYYY-MM-DD', 'YYYY_MM_DD', 'YYYYMMDD');

    // Try parsing the whole basename first (covers date-only filenames)
    const whole = m(basename, candidates, true);
    if (whole && whole.isValid && whole.isValid()) return whole;

    // Otherwise look for a trailing date-like token and try to parse that
    const dateTokenMatch = basename.match(/(\d{4}[-_/]\d{2}[-_/]\d{2}|\d{8})$/);
    if (dateTokenMatch) {
      const token = dateTokenMatch[1];
      const parsed = m(token, candidates, true);
      if (parsed && parsed.isValid && parsed.isValid()) return parsed;
      // lastly try parsing token as ISO/explicit
      const fallback = m(token, ['YYYY-MM-DD', 'YYYYMMDD'], true);
      if (fallback && fallback.isValid && fallback.isValid()) return fallback;
    }

    return null;
  } catch (e) {
    return null;
  }
}

export function isDailyBasename(basename: string, userFormat?: string): boolean {
  const m = parseDateFromFilename(basename, userFormat);
  return !!(m && m.isValid && m.isValid());
}
