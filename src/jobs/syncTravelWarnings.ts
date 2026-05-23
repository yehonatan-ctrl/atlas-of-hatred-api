import { pool } from '../db';

const PACKAGE_ID = 'travelwarnings';
const PACKAGE_SOURCE_URL = 'https://data.gov.il/dataset/travelwarnings';

type CountryMaps = {
  he2: Map<string, string>;
  en2: Map<string, string>;
};

export type TravelWarningSourceRow = Record<string, any>;

export type ExistingTravelWarningRow = {
  country_code: string;
  level: number | null;
  issued_date: string | null;
  source_url: string | null;
  summary: string | null;
};

export type SourceUrlReason =
  | 'details_html'
  | 'recommendations_html'
  | 'field:source_url'
  | 'field:url'
  | 'field:link'
  | 'field:details_url'
  | 'retained_existing_non_l1'
  | 'source_dataset_page'
  | 'source_url_missing_after_fallback';

export type IssuedDateReason =
  | 'field:date'
  | 'field:issued_date'
  | 'field:updated_at'
  | 'field:last_update'
  | 'field:published_at'
  | 'text_token'
  | 'issued_date_unavailable_from_source';

export type TravelWarningMappedRow = {
  country_code: string;
  level: number;
  level_label: string | null;
  summary: string | null;
  issued_date: string | null;
  issued_date_reason: IssuedDateReason;
  source_url: string | null;
  source_url_reason: SourceUrlReason;
  raw_row: TravelWarningSourceRow;
  source_record_id: number | null;
  source_country_value: string;
};

export type TravelWarningUnresolvedCountryRow = {
  source_record_id: number | null;
  raw_country_value: string;
  normalized_country_value: string;
  reason: 'unresolved_country';
};

type SeveritySignal = {
  level: number;
  level_label: string;
  hasSignal: boolean;
};

type SourceUrlDecision = {
  source_url: string | null;
  source_url_reason: SourceUrlReason;
};

type IssuedDateDecision = {
  issued_date: string | null;
  issued_date_reason: IssuedDateReason;
};

type MapRecordResult =
  | { ok: true; row: TravelWarningMappedRow }
  | { ok: false; unresolved: TravelWarningUnresolvedCountryRow };

export type MapTravelWarningResult = {
  rows: TravelWarningMappedRow[];
  misses: Record<string, number>;
  unresolvedCountryRows: TravelWarningUnresolvedCountryRow[];
  countriesConsolidated: number;
  unknownSeverityRows: number;
  sourceUrlReasonCounts: Record<string, number>;
  issuedDateReasonCounts: Record<string, number>;
  countryInputCounts: Record<string, number>;
  duplicateCountryCodes: string[];
};

export type MapTravelWarningOptions = {
  existingByCountry?: Map<string, ExistingTravelWarningRow>;
};

function normalizeCountryKey(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[׳’`´]/g, "'")
    .replace(/[״“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasKey(name: string): string {
  return normalizeCountryKey(name).toLowerCase();
}

const COUNTRY_ALIAS_TO_ISO2 = new Map<string, string>([
  ['טורקיה', 'TR'],
  ['תורכיה', 'TR'],
  ['turkey', 'TR'],
  ['türkiye', 'TR'],
  ['turkiye', 'TR'],
  ['republic of turkey', 'TR'],

  ['איחוד האמירויות הערביות', 'AE'],
  ['איחוד האמירויות', 'AE'],
  ['united arab emirates', 'AE'],
  ['uae', 'AE'],

  ['צפון מקדוניה', 'MK'],
  ['מקדוניה', 'MK'],
  ['מקדוניה הצפונית', 'MK'],
  ['north macedonia', 'MK'],

  ['בוסניה והרצגובינה', 'BA'],
  ['בוסניה הרצגובינה', 'BA'],
  ['bosnia and herzegovina', 'BA'],

  ['דרום קוריאה', 'KR'],
  ['קוריאה', 'KR'],
  ['קוריאה הדרומית', 'KR'],
  ['south korea', 'KR'],
  ['republic of korea', 'KR'],

  ['שבדיה', 'SE'],
  ['שוודיה', 'SE'],
  ['sweden', 'SE'],

  ['נורבגיה', 'NO'],
  ['נורווגיה', 'NO'],
  ['norway', 'NO'],

  ['מקסיקו', 'MX'],
  ['מכסיקו', 'MX'],
  ['mexico', 'MX'],

  ['אורוגואי', 'UY'],
  ['אורוגוואי', 'UY'],
  ['uruguay', 'UY'],

  ['שווייץ', 'CH'],
  ['שוויץ', 'CH'],
  ['switzerland', 'CH'],

  ["אזרביג'אן", 'AZ'],
  ["אזרבייג'ן", 'AZ'],
  ['azerbaijan', 'AZ'],

  ['קזחסטאן', 'KZ'],
  ['קזחסטן', 'KZ'],
  ['kazakhstan', 'KZ'],

  ['ארצות הברית', 'US'],
  ['ארה"ב', 'US'],
  ['usa', 'US'],
  ['u.s.a', 'US'],
  ['united states', 'US'],

  ['בריטניה', 'GB'],
  ['great britain', 'GB'],
  ['britain', 'GB'],
  ['uk', 'GB'],

  ['צ׳כיה', 'CZ'],
  ["צ'כיה", 'CZ'],
  ['czech republic', 'CZ'],
  ['czechia', 'CZ'],

  ["cote d'ivoire", 'CI'],
  ['ivory coast', 'CI'],
].map(([name, iso]) => [aliasKey(name), iso]));

function levelLabel(level: number): string {
  const byLevel: Record<number, string> = {
    4: 'high_threat',
    3: 'moderate_threat',
    2: 'potential_threat',
    1: 'no_travel_threat',
    0: 'unknown',
  };
  return byLevel[level] ?? 'unknown';
}

function pickField(rec: TravelWarningSourceRow, keys: string[]): any {
  for (const k of keys) {
    const v = rec?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function cleanText(value: any): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrlCandidate(value: any): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).replace(/&amp;/gi, '&').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function firstUrlFromHtmlOrText(value: any): string | null {
  const text = String(value ?? '');
  const hrefMatch = text.match(/href=["']([^"']+)["']/i);
  if (hrefMatch?.[1]) {
    const normalizedHref = normalizeUrlCandidate(hrefMatch[1]);
    if (normalizedHref) return normalizedHref;
  }
  const plainMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (plainMatch?.[0]) {
    const normalizedPlain = normalizeUrlCandidate(plainMatch[0]);
    if (normalizedPlain) return normalizedPlain;
  }
  return null;
}

function extractSourceUrlFromRecord(
  rec: TravelWarningSourceRow,
  details: string,
  recommendations: string
): SourceUrlDecision {
  const detailsUrl = firstUrlFromHtmlOrText(details);
  if (detailsUrl) return { source_url: detailsUrl, source_url_reason: 'details_html' };

  const recUrl = firstUrlFromHtmlOrText(recommendations);
  if (recUrl) return { source_url: recUrl, source_url_reason: 'recommendations_html' };

  const fieldPriority: Array<{ keys: string[]; reason: SourceUrlReason }> = [
    { keys: ['source_url', 'SourceUrl'], reason: 'field:source_url' },
    { keys: ['url', 'Url', 'URL'], reason: 'field:url' },
    { keys: ['link', 'Link'], reason: 'field:link' },
    { keys: ['details_url', 'DetailsUrl'], reason: 'field:details_url' },
  ];
  for (const candidate of fieldPriority) {
    const raw = pickField(rec, candidate.keys);
    const normalized = normalizeUrlCandidate(raw);
    if (normalized) return { source_url: normalized, source_url_reason: candidate.reason };
  }

  return { source_url: null, source_url_reason: 'source_url_missing_after_fallback' };
}

function toIsoDate(yearRaw: string | number, monthRaw: string | number, dayRaw: string | number): string | null {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function parseDateStrict(value: any): string | null {
  if (value === undefined || value === null) return null;
  const input = normalizeCountryKey(String(value));
  if (!input) return null;

  let m = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s].*)/);
  if (m) return toIsoDate(m[1], m[2], m[3]);

  m = input.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:$|[T\s].*)/);
  if (m) return toIsoDate(m[1], m[2], m[3]);

  m = input.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:$|[T\s].*)/);
  if (m) return toIsoDate(m[3], m[2], m[1]);

  m = input.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:$|[T\s].*)/);
  if (m) return toIsoDate(m[3], m[2], m[1]);

  const tzDateTime = input.match(
    /^(\d{4}-\d{2}-\d{2})[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+\-]\d{2}:?\d{2})$/
  );
  if (tzDateTime) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function extractDateFromText(details: string, recommendations: string): string | null {
  const text = cleanText(`${details} ${recommendations}`);
  if (!text) return null;
  const regexes = [/\b\d{4}-\d{2}-\d{2}\b/g, /\b\d{2}\/\d{2}\/\d{4}\b/g, /\b\d{2}\.\d{2}\.\d{4}\b/g];
  const parsed = new Set<string>();
  for (const re of regexes) {
    for (const m of text.matchAll(re)) {
      const iso = parseDateStrict(m[0]);
      if (iso) parsed.add(iso);
    }
  }
  if (parsed.size === 1) return Array.from(parsed)[0];
  return null;
}

function extractIssuedDateFromRecord(
  rec: TravelWarningSourceRow,
  details: string,
  recommendations: string
): IssuedDateDecision {
  const orderedFieldChecks: Array<{ keys: string[]; reason: IssuedDateReason }> = [
    { keys: ['date', 'Date'], reason: 'field:date' },
    { keys: ['issued_date', 'IssuedDate'], reason: 'field:issued_date' },
    { keys: ['updated_at', 'UpdatedAt'], reason: 'field:updated_at' },
    { keys: ['last_update', 'LastUpdate'], reason: 'field:last_update' },
    { keys: ['published_at', 'PublishedAt'], reason: 'field:published_at' },
  ];

  for (const candidate of orderedFieldChecks) {
    const raw = pickField(rec, candidate.keys);
    const parsed = parseDateStrict(raw);
    if (parsed) return { issued_date: parsed, issued_date_reason: candidate.reason };
  }

  const parsedFromText = extractDateFromText(details, recommendations);
  if (parsedFromText) return { issued_date: parsedFromText, issued_date_reason: 'text_token' };

  return {
    issued_date: null,
    issued_date_reason: 'issued_date_unavailable_from_source',
  };
}

function deriveSeverity(recommendations: string, details: string, rawLevel: any): SeveritySignal {
  if (rawLevel !== undefined && rawLevel !== null && String(rawLevel).trim() !== '') {
    const directLevel = Number(rawLevel);
    if (Number.isFinite(directLevel)) {
      const clamped = Math.max(0, Math.min(4, Math.trunc(directLevel)));
      return { level: clamped, level_label: levelLabel(clamped), hasSignal: true };
    }
  }

  const text = cleanText(`${recommendations} ${details}`);
  if (!text) return { level: 0, level_label: levelLabel(0), hasSignal: false };

  const explicitLevels = Array.from(text.matchAll(/\u05e8\u05de\u05d4\s*([1-4])/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  if (explicitLevels.length) {
    const maxLevel = Math.max(...explicitLevels);
    return { level: maxLevel, level_label: levelLabel(maxLevel), hasSignal: true };
  }

  if (
    /\u05d0\u05d9\u05d5\u05dd\s*\u05d2\u05d1\u05d5\u05d4|\u05d0\u05d9\u05d5\u05dd\s*\u05e7\u05d9\u05e6\u05d5\u05e0\u05d9|\u05dc\u05d4\u05d9\u05de\u05e0\u05e2\s*\u05de\u05d4\u05d2\u05e2\u05d4|\u05d0\u05d9\u05df\s*\u05dc\u05d4\u05d2\u05d9\u05e2|\u05dc\u05e2\u05d6\u05d5\u05d1.*\u05d1\u05d4\u05e7\u05d3\u05dd|\u05dc\u05e6\u05d0\u05ea.*\u05d1\u05d4\u05e7\u05d3\u05dd/i.test(
      text
    )
  ) {
    return { level: 4, level_label: levelLabel(4), hasSignal: true };
  }
  if (
    /\u05d0\u05d9\u05d5\u05dd\s*\u05d1\u05d9\u05e0\u05d5\u05e0\u05d9|\u05dc\u05d4\u05d9\u05de\u05e0\u05e2\s*\u05de\u05e0\u05e1\u05d9\u05e2\u05d5\u05ea\s*\u05e9\u05d0\u05d9\u05e0\u05df\s*\u05d7\u05d9\u05d5\u05e0\u05d9\u05d5\u05ea/i.test(
      text
    )
  ) {
    return { level: 3, level_label: levelLabel(3), hasSignal: true };
  }
  if (
    /\u05d0\u05d9\u05d5\u05dd\s*\u05de\u05d6\u05d3\u05de\u05df|\u05d6\u05d4\u05d9\u05e8\u05d5\u05ea\s*\u05de\u05d5\u05d2\u05d1\u05e8|\u05d0\u05de\u05e6\u05e2\u05d9\s*\u05d6\u05d4\u05d9\u05e8\u05d5\u05ea\s*\u05de\u05d5\u05d2\u05d1\u05e8|\u05e2\u05e8\u05e0\u05d5\u05ea\s*\u05de\u05d5\u05d2\u05d1\u05e8\u05ea|\u05e9\u05d9\u05de\u05e8\u05d5\s*\u05e2\u05dc\s*\u05e2\u05d9\u05e8\u05e0\u05d5\u05ea|\u05de\u05e9\u05e0\u05d4\s*\u05d6\u05d4\u05d9\u05e8\u05d5\u05ea/i.test(
      text
    )
  ) {
    return { level: 2, level_label: levelLabel(2), hasSignal: true };
  }
  if (/\u05d0\u05d9\u05df\s*\u05d0\u05d6\u05d4\u05e8\u05d5\u05ea|\u05dc\u05dc\u05d0\s*\u05d0\u05d9\u05d5\u05dd/i.test(text)) {
    return { level: 1, level_label: levelLabel(1), hasSignal: true };
  }

  return { level: 0, level_label: levelLabel(0), hasSignal: false };
}

function compareIsoDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a > b ? 1 : -1;
}

function numericRecordId(rec: TravelWarningSourceRow): number | null {
  const n = Number(rec?._id);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function preferredRow(current: TravelWarningMappedRow, candidate: TravelWarningMappedRow): TravelWarningMappedRow {
  if (candidate.level !== current.level) {
    return candidate.level > current.level ? candidate : current;
  }

  const dateCmp = compareIsoDate(candidate.issued_date, current.issued_date);
  if (dateCmp !== 0) return dateCmp > 0 ? candidate : current;

  const candidateHasUrl = candidate.source_url ? 1 : 0;
  const currentHasUrl = current.source_url ? 1 : 0;
  if (candidateHasUrl !== currentHasUrl) {
    return candidateHasUrl > currentHasUrl ? candidate : current;
  }

  const candidateSummaryLen = candidate.summary?.length ?? 0;
  const currentSummaryLen = current.summary?.length ?? 0;
  if (candidateSummaryLen !== currentSummaryLen) {
    return candidateSummaryLen > currentSummaryLen ? candidate : current;
  }

  const candidateId = candidate.source_record_id ?? Number.MAX_SAFE_INTEGER;
  const currentId = current.source_record_id ?? Number.MAX_SAFE_INTEGER;
  if (candidateId !== currentId) {
    return candidateId < currentId ? candidate : current;
  }

  return current;
}

function normalizeCountry(name: string, he2: Map<string, string>, en2: Map<string, string>): string | null {
  const normalized = normalizeCountryKey(name ?? '');
  if (!normalized) return null;
  if (/^[A-Za-z]{2}$/.test(normalized)) return normalized.toUpperCase();

  const byAlias = COUNTRY_ALIAS_TO_ISO2.get(aliasKey(normalized));
  if (byAlias) return byAlias;

  if (he2.has(normalized)) return he2.get(normalized)!;

  const low = normalized.toLowerCase();
  if (en2.has(low)) return en2.get(low)!;

  return null;
}

function mapRecord(rec: TravelWarningSourceRow, maps: CountryMaps): MapRecordResult {
  const rawCountry = pickField(rec, ['country', 'Country', 'מדינה', 'שם מדינה']);
  const rawCountryValue = normalizeCountryKey(String(rawCountry ?? ''));
  const iso2 = normalizeCountry(rawCountryValue, maps.he2, maps.en2);
  if (!iso2) {
    return {
      ok: false,
      unresolved: {
        source_record_id: numericRecordId(rec),
        raw_country_value: String(rawCountry ?? '').trim(),
        normalized_country_value: rawCountryValue || '(empty)',
        reason: 'unresolved_country',
      },
    };
  }

  const recommendations = String(
    pickField(rec, ['recommendations', 'Recommendations', 'summary', 'Summary', 'הערות', 'הנחיות']) ?? ''
  );
  const details = String(pickField(rec, ['details', 'Details']) ?? '');
  const rawLevel = pickField(rec, ['level', 'Level', 'דרגה', 'רמה']);

  const severity = deriveSeverity(recommendations, details, rawLevel);
  const summaryText = cleanText(recommendations) || cleanText(details);
  const sourceUrl = extractSourceUrlFromRecord(rec, details, recommendations);
  const issuedDate = extractIssuedDateFromRecord(rec, details, recommendations);

  return {
    ok: true,
    row: {
      country_code: iso2,
      level: severity.level,
      level_label: severity.level_label,
      summary: summaryText ? summaryText.slice(0, 600) : null,
      issued_date: issuedDate.issued_date,
      issued_date_reason: issuedDate.issued_date_reason,
      source_url: sourceUrl.source_url,
      source_url_reason: sourceUrl.source_url_reason,
      raw_row: rec,
      source_record_id: numericRecordId(rec),
      source_country_value: rawCountryValue,
    },
  };
}

function sortedObjectFromMap(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])));
}

function sortedCountObjectFromMap(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export async function loadCountryMaps(): Promise<CountryMaps> {
  const he2 = new Map<string, string>();
  const en2 = new Map<string, string>();
  const { rows } = await pool.query('SELECT code, name_he, name_en FROM countries');
  for (const r of rows) {
    if (r.name_he) he2.set(normalizeCountryKey(String(r.name_he)), r.code);
    if (r.name_en) en2.set(normalizeCountryKey(String(r.name_en)).toLowerCase(), r.code);
  }
  return { he2, en2 };
}

export async function loadExistingTravelWarningsByCountry(): Promise<Map<string, ExistingTravelWarningRow>> {
  const byCountry = new Map<string, ExistingTravelWarningRow>();
  try {
    const { rows } = await pool.query(`
      SELECT country_code, level, issued_date::text AS issued_date, source_url, summary
      FROM travel_warnings
    `);
    for (const r of rows) {
      const key = normalizeCountryKey(String(r.country_code)).toUpperCase();
      if (!/^[A-Z]{2}$/.test(key)) continue;
      byCountry.set(key, {
        country_code: key,
        level: Number.isFinite(Number(r.level)) ? Number(r.level) : null,
        issued_date: r.issued_date ? String(r.issued_date) : null,
        source_url: r.source_url ? String(r.source_url) : null,
        summary: r.summary ? String(r.summary) : null,
      });
    }
  } catch (err: any) {
    if (err?.code === '42P01') {
      return byCountry;
    }
    throw err;
  }
  return byCountry;
}

async function ckanGet(url: string, params: Record<string, string>) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`CKAN HTTP ${res.status}`);
  const data: any = await res.json();
  if (!data?.success) throw new Error('CKAN error');
  return data.result;
}

function pickResource(pkg: any) {
  const resources = pkg?.resources ?? [];
  if (!resources.length) throw new Error('No CKAN resources');
  const ds = resources.find((r: any) => r?.datastore_active);
  return ds ?? resources[0];
}

export async function fetchTravelWarningSourceRecords({ limit = 500 }: { limit?: number } = {}) {
  const pkg = await ckanGet('https://data.gov.il/api/3/action/package_show', { id: PACKAGE_ID });
  const resource = pickResource(pkg);
  const resourceId = resource.id;
  const out = await ckanGet('https://data.gov.il/api/3/action/datastore_search', {
    resource_id: resourceId,
    limit: String(limit),
  });
  const records: TravelWarningSourceRow[] = out?.records ?? [];
  return {
    packageId: PACKAGE_ID,
    resourceId,
    total: Number(out?.total ?? records.length),
    records,
  };
}

export function mapTravelWarningRecords(
  records: TravelWarningSourceRow[],
  maps: CountryMaps,
  options: MapTravelWarningOptions = {}
): MapTravelWarningResult {
  const misses = new Map<string, number>();
  const unresolvedCountryRows: TravelWarningUnresolvedCountryRow[] = [];
  const countryInputCounts = new Map<string, number>();
  const byCountry = new Map<string, TravelWarningMappedRow>();
  let unknownSeverityRows = 0;

  for (const rec of records) {
    const mapped = mapRecord(rec, maps);
    if (!mapped.ok) {
      const key = mapped.unresolved.normalized_country_value || '(empty)';
      misses.set(key, (misses.get(key) ?? 0) + 1);
      unresolvedCountryRows.push(mapped.unresolved);
      continue;
    }

    if (mapped.row.level === 0) unknownSeverityRows += 1;

    countryInputCounts.set(mapped.row.country_code, (countryInputCounts.get(mapped.row.country_code) ?? 0) + 1);

    const existing = byCountry.get(mapped.row.country_code);
    if (!existing) {
      byCountry.set(mapped.row.country_code, mapped.row);
      continue;
    }
    byCountry.set(mapped.row.country_code, preferredRow(existing, mapped.row));
  }

  const rows = Array.from(byCountry.values()).sort((a, b) => a.country_code.localeCompare(b.country_code));

  for (const row of rows) {
    if (!row.source_url && row.level >= 2) {
      const existingUrl = normalizeUrlCandidate(options.existingByCountry?.get(row.country_code)?.source_url);
      if (existingUrl) {
        row.source_url = existingUrl;
        row.source_url_reason = 'retained_existing_non_l1';
      }
    }

    if (!row.source_url) {
      row.source_url = PACKAGE_SOURCE_URL;
      row.source_url_reason = 'source_dataset_page';
    }
  }

  const sourceUrlReasonCounts = new Map<string, number>();
  const issuedDateReasonCounts = new Map<string, number>();
  for (const row of rows) {
    sourceUrlReasonCounts.set(row.source_url_reason, (sourceUrlReasonCounts.get(row.source_url_reason) ?? 0) + 1);
    issuedDateReasonCounts.set(row.issued_date_reason, (issuedDateReasonCounts.get(row.issued_date_reason) ?? 0) + 1);
  }

  const duplicateCountryCodes = Array.from(countryInputCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([code]) => code)
    .sort((a, b) => a.localeCompare(b));

  return {
    rows,
    misses: sortedCountObjectFromMap(misses),
    unresolvedCountryRows: unresolvedCountryRows.sort((a, b) => {
      const aId = a.source_record_id ?? Number.MAX_SAFE_INTEGER;
      const bId = b.source_record_id ?? Number.MAX_SAFE_INTEGER;
      if (aId !== bId) return aId - bId;
      return a.normalized_country_value.localeCompare(b.normalized_country_value);
    }),
    countriesConsolidated: rows.length,
    unknownSeverityRows,
    sourceUrlReasonCounts: sortedObjectFromMap(sourceUrlReasonCounts),
    issuedDateReasonCounts: sortedObjectFromMap(issuedDateReasonCounts),
    countryInputCounts: sortedObjectFromMap(countryInputCounts),
    duplicateCountryCodes,
  };
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS travel_warnings (
      country_code CHAR(2) PRIMARY KEY,
      level SMALLINT NOT NULL,
      level_label TEXT,
      summary TEXT,
      issued_date DATE,
      source_url TEXT,
      raw_row JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function syncTravelWarnings({ limit = 500 }: { limit?: number } = {}) {
  await ensureTable();
  const source = await fetchTravelWarningSourceRecords({ limit });
  if (!source.records.length) throw new Error('No records from CKAN');

  const maps = await loadCountryMaps();
  const existingByCountry = await loadExistingTravelWarningsByCountry();
  const mapped = mapTravelWarningRecords(source.records, maps, { existingByCountry });
  const rows = mapped.rows;

  const q = `
    INSERT INTO travel_warnings (country_code, level, level_label, summary, issued_date, source_url, raw_row, fetched_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, NOW(), NOW())
    ON CONFLICT (country_code) DO UPDATE SET
      level = EXCLUDED.level,
      level_label = EXCLUDED.level_label,
      summary = EXCLUDED.summary,
      issued_date = EXCLUDED.issued_date,
      source_url = EXCLUDED.source_url,
      raw_row = EXCLUDED.raw_row,
      fetched_at = NOW(),
      updated_at = NOW()
    WHERE
      travel_warnings.level IS DISTINCT FROM EXCLUDED.level
      OR travel_warnings.level_label IS DISTINCT FROM EXCLUDED.level_label
      OR travel_warnings.summary IS DISTINCT FROM EXCLUDED.summary
      OR travel_warnings.issued_date IS DISTINCT FROM EXCLUDED.issued_date
      OR travel_warnings.source_url IS DISTINCT FROM EXCLUDED.source_url
      OR travel_warnings.raw_row IS DISTINCT FROM EXCLUDED.raw_row;
  `;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(q, [
        r.country_code,
        r.level,
        r.level_label,
        r.summary,
        r.issued_date,
        r.source_url,
        r.raw_row,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return {
    recordsSeen: source.records.length,
    recordsTotal: source.total,
    mappedRows: rows.length,
    countriesConsolidated: mapped.countriesConsolidated,
    unknownSeverityRows: mapped.unknownSeverityRows,
    unresolvedCountryRows: mapped.unresolvedCountryRows.length,
    sourceUrlReasonCounts: mapped.sourceUrlReasonCounts,
    issuedDateReasonCounts: mapped.issuedDateReasonCounts,
    duplicateCountryGroups: mapped.duplicateCountryCodes.length,
    misses: mapped.misses,
  };
}

if (require.main === module) {
  syncTravelWarnings({ limit: Number(process.env.TW_LIMIT ?? 500) })
    .then((r) => {
      console.log('SYNC_OK', JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error('SYNC_FAIL', err);
      process.exit(1);
    });
}
