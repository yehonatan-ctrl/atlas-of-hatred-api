import { pool } from '../db';

const PACKAGE_ID = 'travelwarnings';

async function ckanGet(url: string, params: Record<string, string>) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u.toString(), { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`CKAN HTTP ${res.status}`);
  const data: any = await res.json();
  if (!data?.success) throw new Error(`CKAN error`);
  return data.result;
}

function pickResource(pkg: any) {
  const resources = pkg?.resources ?? [];
  if (!resources.length) throw new Error('No CKAN resources');
  // Prefer datastore_active
  const ds = resources.find((r: any) => r?.datastore_active);
  return ds ?? resources[0];
}

async function loadCountryMaps() {
  const he2 = new Map<string, string>();
  const en2 = new Map<string, string>();
  const { rows } = await pool.query('SELECT code, name_he, name_en FROM countries');
  for (const r of rows) {
    if (r.name_he) he2.set(String(r.name_he).trim(), r.code);
    if (r.name_en) en2.set(String(r.name_en).trim().toLowerCase(), r.code);
  }
  return { he2, en2 };
}

function normalizeCountry(name: string, he2: Map<string, string>, en2: Map<string, string>): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  if (he2.has(n)) return he2.get(n)!;
  const low = n.toLowerCase();
  if (en2.has(low)) return en2.get(low)!;
  const aliases: Record<string, string> = {
    'ארצות הברית': 'US',
    'ארה"ב': 'US',
    'בריטניה': 'GB',
    'איחוד האמירויות הערביות': 'AE',
    "צ׳כיה": 'CZ',
    "צ'כיה": 'CZ',
    'שווייץ': 'CH',
    'אוסטרליה': 'AU',
    'בלגיה': 'BE',
    'ספרד': 'ES',
    'שוודיה': 'SE',
    "צ'ילה": 'CL',
    'איטליה': 'IT',
    'הודו': 'IN',
    'יפן': 'JP',
    'פורטוגל': 'PT',
    'רומניה': 'RO',
    'מצרים': 'EG',
    'ירדן': 'JO',
    'יוון': 'GR',
    'קפריסין': 'CY',
    'תאילנד': 'TH',
    'גאורגיה': 'GE',
    'מרוקו': 'MA',
  };
  return aliases[n] ?? null;
}

function parseDate(val: any): string | null {
  if (!val) return null;
  const s = String(val).trim();
  // Accept YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY
  const tryFormats: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, m => `${m[1]}-${m[2]}-${m[3]}`],
    [/^(\d{2})\/(\d{2})\/(\d{4})$/, m => `${m[3]}-${m[2]}-${m[1]}`],
    [/^(\d{2})\.(\d{2})\.(\d{4})$/, m => `${m[3]}-${m[2]}-${m[1]}`],
  ];
  for (const [re, fn] of tryFormats) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return null;
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

  const records: any[] = out?.records ?? [];
  if (!records.length) throw new Error('No records from CKAN');

  const { he2, en2 } = await loadCountryMaps();

  const misses = new Map<string, number>();
  const rows: any[] = [];

  const pick = (rec: any, keys: string[]) => {
    for (const k of keys) {
      const v = rec?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return null;
  };

  for (const rec of records) {
    const countryName = pick(rec, ['country', 'Country', 'מדינה', 'שם מדינה']);
    const level = pick(rec, ['level', 'Level', 'דרגה', 'רמה']);
    const levelLabel = pick(rec, ['level_label', 'LevelLabel', 'תיאור', 'הנחיה']);
    const summary = pick(rec, ['summary', 'Summary', 'הערות', 'הנחיות']);
    const issued = pick(rec, ['issued_date', 'IssuedDate', 'תאריך', 'תאריך עדכון']);
    const sourceUrl = pick(rec, ['source_url', 'SourceUrl', 'קישור', 'לינק']);

    const iso2 = normalizeCountry(String(countryName ?? ''), he2, en2);
    if (!iso2) {
      const key = String(countryName ?? '').trim() || '(empty)';
      misses.set(key, (misses.get(key) ?? 0) + 1);
      continue;
    }

    const lvl = Number(level);
    if (!Number.isFinite(lvl)) continue;

    rows.push({
      country_code: iso2,
      level: Math.trunc(lvl),
      level_label: levelLabel ? String(levelLabel) : null,
      summary: summary ? String(summary) : null,
      issued_date: parseDate(issued),
      source_url: sourceUrl ? String(sourceUrl) : null,
      raw_row: rec,
    });
  }

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
    misses: Object.fromEntries(Array.from(misses.entries()).sort((a, b) => b[1] - a[1])),
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
