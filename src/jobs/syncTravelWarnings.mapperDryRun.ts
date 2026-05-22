import assert from 'node:assert/strict';
import { mapTravelWarningRecords, type TravelWarningSourceRow } from './syncTravelWarnings';

const he = {
  uganda: '\u05d0\u05d5\u05d2\u05e0\u05d3\u05d4',
  uzbekistan: '\u05d0\u05d5\u05d6\u05d1\u05e7\u05d9\u05e1\u05d8\u05d0\u05df',
  austria: '\u05d0\u05d5\u05e1\u05d8\u05e8\u05d9\u05d4',
  uruguay: '\u05d0\u05d5\u05e8\u05d5\u05d2\u05d5\u05d0\u05d9',
  uae: '\u05d0\u05d9\u05d7\u05d5\u05d3 \u05d4\u05d0\u05de\u05d9\u05e8\u05d5\u05d9\u05d5\u05ea \u05d4\u05e2\u05e8\u05d1\u05d9\u05d5\u05ea',
  healthInfo:
    '\u05de\u05d9\u05d3\u05e2 \u05d1\u05e8\u05d9\u05d0\u05d5\u05ea\u05d9 \u05e2\u05d3\u05db\u05e0\u05d9 \u05dc\u05e0\u05d5\u05e1\u05e2\u05d9\u05dd \u05dc\u05d7\u05d5\u05e5 \u05dc\u05d0\u05e8\u05e5',
  level2:
    '\u05e8\u05de\u05d4 2/ \u05d0\u05d9\u05d5\u05dd \u05de\u05d6\u05d3\u05de\u05df: \u05d4\u05de\u05dc\u05e6\u05d4 \u05dc\u05e0\u05e7\u05d5\u05d8 \u05d1\u05d0\u05de\u05e6\u05e2\u05d9 \u05d6\u05d4\u05d9\u05e8\u05d5\u05ea \u05de\u05d5\u05d2\u05d1\u05e8\u05d9\u05dd.',
  mixed43:
    '\u05e8\u05de\u05ea \u05d0\u05d9\u05d5\u05dd \u05de\u05e9\u05d5\u05dc\u05d1\u05ea: \u05e8\u05de\u05d4 4/ \u05d0\u05d9\u05d5\u05dd \u05d2\u05d1\u05d5\u05d4 \u05d5\u05dc\u05d4\u05d9\u05de\u05e0\u05e2 \u05de\u05d4\u05d2\u05e2\u05d4 \u05dc\u05d0\u05d9\u05d6\u05d5\u05e8 \u05d4\u05d2\u05d1\u05d5\u05dc \u05e2\u05dd \u05d0\u05e4\u05d2\u05e0\u05d9\u05e1\u05d8\u05df. \u05e8\u05de\u05d4 3/ \u05d0\u05d9\u05d5\u05dd \u05d1\u05d9\u05e0\u05d5\u05e0\u05d9 \u05d5\u05dc\u05d4\u05d9\u05de\u05e0\u05e2 \u05de\u05e0\u05e1\u05d9\u05e2\u05d5\u05ea \u05e9\u05d0\u05d9\u05e0\u05df \u05d7\u05d9\u05d5\u05e0\u05d9\u05d5\u05ea \u05dc\u05e9\u05d0\u05e8 \u05e9\u05d8\u05d7\u05d9 \u05d4\u05de\u05d3\u05d9\u05e0\u05d4.',
  keepAlert:
    '\u05e9\u05d9\u05de\u05e8\u05d5 \u05e2\u05dc \u05e2\u05d9\u05e8\u05e0\u05d5\u05ea, \u05d4\u05e7\u05e9\u05d9\u05d1\u05d5 \u05dc\u05d0\u05de\u05e6\u05e2\u05d9 \u05d4\u05ea\u05e7\u05e9\u05d5\u05e8\u05ea.',
  noWarnings: '\u05d0\u05d9\u05df \u05d0\u05d6\u05d4\u05e8\u05d5\u05ea',
  nscLink:
    '\u05dc\u05d4\u05de\u05dc\u05e6\u05d4 \u05d1\u05d0\u05ea\u05e8 \u05d4\u05de\u05d8\u05d4 \u05dc\u05d1\u05d9\u05d8\u05d7\u05d5\u05df \u05dc\u05d0\u05d5\u05de\u05d9',
  moFaLink:
    '\u05dc\u05d4\u05de\u05dc\u05e6\u05d4 \u05d1\u05d0\u05ea\u05e8 \u05de\u05e9\u05e8\u05d3 \u05d4\u05d7\u05d5\u05e5',
};

const sampleRows: TravelWarningSourceRow[] = [
  {
    _id: 1,
    country: he.uganda,
    recommendations: `<a href="https://www.gov.il/he/departments/topics/travelers-health/govil-landing-page">${he.healthInfo}</a>`,
    details: '',
    date: null,
  },
  {
    _id: 2,
    country: he.uganda,
    recommendations: he.level2,
    details: `<a href="https://www.gov.il/he/Departments/DynamicCollectors/travel-warnings-nsc?skip=0&country=001">${he.nscLink}</a>`,
    date: null,
  },
  {
    _id: 5,
    country: he.uzbekistan,
    recommendations: he.mixed43,
    details: `<a href="https://www.gov.il/he/Departments/DynamicCollectors/travel-warnings-nsc?skip=0&country=002">${he.nscLink}</a>`,
    date: null,
  },
  {
    _id: 9,
    country: he.austria,
    recommendations: he.level2,
    details: `<a href="https://www.gov.il/he/Departments/DynamicCollectors/travel-warnings-nsc?skip=0&country=003">${he.nscLink}</a>`,
    date: null,
  },
  {
    _id: 18,
    country: he.uruguay,
    recommendations: he.keepAlert,
    details: '',
    date: null,
  },
  {
    _id: 19,
    country: he.uruguay,
    recommendations: he.noWarnings,
    details: '',
    date: null,
  },
  {
    _id: 23,
    country: he.uae,
    recommendations: `<a href="https://www.gov.il/he/departments/topics/travelers-health/govil-landing-page">${he.healthInfo}</a>`,
    details: '',
    date: null,
  },
  {
    _id: 24,
    country: he.uae,
    recommendations: he.keepAlert,
    details: `<a href="https://www.gov.il/he/departments/publications/reports/update_visa_exemption_agreement_with_the_united_arab_emirates">${he.moFaLink}</a>`,
    date: null,
  },
];

const maps = {
  he2: new Map<string, string>([
    [he.uganda, 'UG'],
    [he.uzbekistan, 'UZ'],
    [he.austria, 'AT'],
    [he.uruguay, 'UY'],
    [he.uae, 'AE'],
  ]),
  en2: new Map<string, string>(),
};

const run1 = mapTravelWarningRecords(sampleRows, maps);
const run2 = mapTravelWarningRecords(sampleRows, maps);

if (process.env.TW_DEBUG_DRYRUN === '1') {
  console.log(JSON.stringify(run1, null, 2));
}

assert.deepEqual(run1.rows, run2.rows);
assert.equal(run1.rows.length, 5);

const byCode = new Map(run1.rows.map((row) => [row.country_code, row]));
assert.equal(byCode.get('UG')?.level, 2);
assert.equal(byCode.get('UZ')?.level, 4);
assert.equal(byCode.get('AT')?.level, 2);
assert.equal(byCode.get('UY')?.level, 2);
assert.equal(byCode.get('AE')?.level, 2);

console.log(
  JSON.stringify(
    {
      ok: true,
      mappedRows: run1.rows.length,
      countriesConsolidated: run1.countriesConsolidated,
      unknownSeverityRows: run1.unknownSeverityRows,
      rows: run1.rows,
      misses: run1.misses,
    },
    null,
    2
  )
);
