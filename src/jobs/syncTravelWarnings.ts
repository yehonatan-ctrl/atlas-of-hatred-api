import { pool } from '../db';

const PACKAGE_ID = 'travelwarnings';

type CountryMaps = {
  he2: Map<string, string>;
  en2: Map<string, string>;
};

export type TravelWarningSourceRow = Record<string, any>;

export type TravelWarningMappedRow = {
  country_code: string;
  level: number;
  level_label: string | null;
  summary: string | null;
  issued_date: string | null;
  source_url: string | null;
  raw_row: TravelWarningSourceRow;
};

type SeveritySignal = {
  level: number;
  level_label: string;
  hasSignal: boolean;
};

type MapRecordResult =
  | { ok: true; row: TravelWarningMappedRow }
  | { ok: false; miss: string };

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

function normalizeCountryKey(name: string): string {
  return name
    .replace(/[׳‘`]/g, "'")
    .replace(/[״“”]/g, '"')
    .replace(/\u200f|\u200e/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadCountryMaps(): Promise<CountryMaps> {
  const he2 = new Map<string, string>();
  const en2 = new Map<string, string>();
  const { rows } = await pool.query('SELECT code, name_he, name_en FROM countries');
  for (const r of rows) {
    if (r.name_he) {
      he2.set(normalizeCountryKey(String(r.name_he)), r.code);
    }
    if (r.name_en) {
      en2.set(normalizeCountryKey(String(r.name_en)).toLowerCase(), r.code);
    }
  }
  return { he2, en2 };
}

function normalizeCountry(name: string, he2: Map<string, string>, en2: Map<string, string>): string | null {
  const n = normalizeCountryKey(name ?? '');
  if (!n) return null;
  if (/^[A-Za-z]{2}$/.test(n)) return n.toUpperCase();
  if (he2.has(n)) return he2.get(n)!;

  const low = n.toLowerCase();
  if (en2.has(low)) return en2.get(low)!;

  const aliases: Record<string, string> = {
    usa: 'US',
    'u.s.a': 'US',
    'united states': 'US',
    uk: 'GB',
    britain: 'GB',
    'great britain': 'GB',
    uae: 'AE',
    'czech republic': 'CZ',
    czechia: 'CZ',
    "cote d'ivoire": 'CI',
    'ivory coast': 'CI',
  };

  return aliases[low] ?? null;
}

function parseDate(val: any): string | null {
  if (!val) return null;
  const s = String(val).trim();
  const tryFormats: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [/^(\d{2})\/(\d{2})\/(\d{4})$/, (m) => `${m[3]}-${m[2]}-${m[1]}`],
    [/^(\d{2})\.(\d{2})\.(\d{4})$/, (m) => `${m[3]}-${m[2]}-${m[1]}`],
  ];
  for (const [re, fn] of tryFormats) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return null;
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

function firstUrl(value: any): string | null {
  const text = String(value ?? '');
  const href = text.match(/href=["']([^"']+)["']/i);
  if (href?.[1]) return href[1];
  const plain = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (plain?.[0]) return plain[0];
  return null;
}

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
    /\u05d0\u05d9\u05d5\u05dd\s*\u05de\u05d6\u05d3\u05de\u05df|\u05d6\u05d4\u05d9\u05e8\u05d5\u05ea\s*\u05de\u05d5\u05d2\u05d1\u05e8|\u05d0\u05de\u05e6\u05e2\u05d9\s*\u05d6\u05d4\u05d9\u05e8\u05d5\u05ea\s*\u05de\u05d5\u05d2\u05d1\u05e8|\u05e2\u05e8\u05e0\u05d5\u05ea\s*\u05de\u05d5\u05d2\u05d1\u05e8\u05ea|\u05e9\u05d9\u05de\u05e8\u05d5\s*\u05e2\u05dc\s*\u05e2\u05d9\u05e8\u05e0\u05d5\u05ea/i.test(
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

  const candId = Number(candidate.raw_row?._id);
  const currId = Number(current.raw_row?._id);
  const candFinite = Number.isFinite(candId);
  const currFinite = Number.isFinite(currId);
  if (candFinite && currFinite && candId !== currId) {
    return candId < currId ? candidate : current;
  }

  return current;
}

function mapRecord(rec: TravelWarningSourceRow, maps: CountryMaps): MapRecordResult {
  const countryName = pickField(rec, ['country', 'Country']);
  const iso2 = normalizeCountry(String(countryName ?? ''), maps.he2, maps.en2);
  if (!iso2) {
    const miss = normalizeCountryKey(String(countryName ?? '')) || '(empty)';
    return { ok: false, miss };
  }

  const recommendations = String(pickField(rec, ['recommendations', 'Recommendations', 'summary', 'Summary']) ?? '');
  const details = String(pickField(rec, ['details', 'Details']) ?? '');
  const issuedRaw = pickField(rec, ['date', 'Date', 'issued_date', 'IssuedDate']);
  const rawLevel = pickField(rec, ['level', 'Level']);

  const severity = deriveSeverity(recommendations, details, rawLevel);
  const summaryText = cleanText(recommendations) || cleanText(details);
  const sourceUrl = firstUrl(details) ?? firstUrl(recommendations);

  return {
    ok: true,
    row: {
      country_code: iso2,
      level: severity.level,
      level_label: severity.level_label,
      summary: summaryText ? summaryText.slice(0, 600) : null,
      issued_date: parseDate(issuedRaw),
      source_url: sourceUrl,
      raw_row: rec,
    },
  };
}

export function mapTravelWarningRecords(records: TravelWarningSourceRow[], maps: CountryMaps) {
  const misses = new Map<string, number>();
  const byCountry = new Map<string, TravelWarningMappedRow>();
  let unknownSeverityRows = 0;

  for (const rec of records) {
    const mapped = mapRecord(rec, maps);
    if (!mapped.ok) {
      misses.set(mapped.miss, (misses.get(mapped.miss) ?? 0) + 1);
      continue;
    }

    if (mapped.row.level === 0) unknownSeverityRows += 1;

    const existing = byCountry.get(mapped.row.country_code);
    if (!existing) {
      byCountry.set(mapped.row.country_code, mapped.row);
      continue;
    }
    byCountry.set(mapped.row.country_code, preferredRow(existing, mapped.row));
  }

  const rows = Array.from(byCountry.values()).sort((a, b) => a.country_code.localeCompare(b.country_code));
  return {
    rows,
    misses: Object.fromEntries(Array.from(misses.entries()).sort((a, b) => b[1] - a[1])),
    countriesConsolidated: rows.length,
    unknownSeverityRows,
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
  const pkg = await ckanGet('https://data.gov.il/api/3/action/package_show', { id: PACKAGE_ID });
  const res = pickResource(pkg);
  const resourceId = res.id;

  const out = await ckanGet('https://data.gov.il/api/3/action/datastore_search', {
    resource_id: resourceId,
    limit: String(limit),
  });

  const records: TravelWarningSourceRow[] = out?.records ?? [];
  if (!records.length) throw new Error('No records from CKAN');

  const maps = await loadCountryMaps();
  const mapped = mapTravelWarningRecords(records, maps);
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
    WHERE travel_warnings.raw_row IS DISTINCT FROM EXCLUDED.raw_row;
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
    recordsSeen: records.length,
    mappedRows: rows.length,
    countriesConsolidated: mapped.countriesConsolidated,
    unknownSeverityRows: mapped.unknownSeverityRows,
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
