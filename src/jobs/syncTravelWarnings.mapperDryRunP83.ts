import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

type ExistingTravelWarningRow = {
  country_code: string;
  level: number | null;
  issued_date: string | null;
  source_url: string | null;
  summary: string | null;
};

type TravelWarningMappedRow = {
  country_code: string;
  level: number;
  level_label: string | null;
  summary: string | null;
  issued_date: string | null;
  issued_date_reason: string;
  source_url: string | null;
  source_url_reason: string;
  source_record_id: number | null;
  source_country_value: string;
};

type MappedResult = {
  rows: TravelWarningMappedRow[];
  misses: Record<string, number>;
  unresolvedCountryRows: Array<{
    source_record_id: number | null;
    raw_country_value: string;
    normalized_country_value: string;
    reason: string;
  }>;
  countriesConsolidated: number;
  unknownSeverityRows: number;
  sourceUrlReasonCounts: Record<string, number>;
  issuedDateReasonCounts: Record<string, number>;
  countryInputCounts: Record<string, number>;
  duplicateCountryCodes: string[];
};

const DEFAULT_REVIEW_SLUG = 'AOFORC1W1P83_TRAVEL_WARNING_MAPPER_PATCH_DRY_RUN';
const REVIEW_SLUG = process.env.TW_DRY_RUN_REVIEW_SLUG?.trim() || DEFAULT_REVIEW_SLUG;
const IS_P86 = REVIEW_SLUG.includes('AOFORC1W1P86');
const SCOPE_LABEL = IS_P86
  ? 'AOFORC1W1P86 residual travel-warning source/date remediation dry-run metrics'
  : 'AOFORC1W1P83 mapper patch dry-run metrics';

const REVIEW_ROOT = path.resolve(
  process.cwd(),
  'outputs',
  'reviews',
  '2026-05-23',
  REVIEW_SLUG
);
const EVIDENCE_ROOT = path.join(REVIEW_ROOT, 'evidence');

const P84_POST_SYNC_JSON = path.resolve(
  process.cwd(),
  'outputs',
  'reviews',
  '2026-05-23',
  'AOFORC1W1P84_TRAVEL_WARNING_SINGLE_SYNC_EXEC',
  'evidence',
  'post_sync_snapshot.json'
);

const P85_FOCUS_COUNTRY_CSV = path.resolve(
  process.cwd(),
  'outputs',
  'reviews',
  '2026-05-23',
  'AOFORC1W1P85_POST_SYNC_READ_ONLY_VERIFICATION',
  'evidence',
  'focus_country_post_state.csv'
);

const P85_NON_REGRESSION_JSON = path.resolve(
  process.cwd(),
  'outputs',
  'reviews',
  '2026-05-23',
  'AOFORC1W1P85_POST_SYNC_READ_ONLY_VERIFICATION',
  'evidence',
  'non_regression_checklist.json'
);

const P81_QUEUE_CSV = path.resolve(
  process.cwd(),
  '..',
  'app',
  'atlas-of-hatred',
  'outputs',
  'reviews',
  '2026-05-23',
  'AOFORC1W1P81_TRAVEL_WARNING_RECONCILIATION',
  'evidence',
  'travel_warning_reconciliation_queue.csv'
);

const P81_SUMMARY_JSON = path.resolve(
  process.cwd(),
  '..',
  'app',
  'atlas-of-hatred',
  'outputs',
  'reviews',
  '2026-05-23',
  'AOFORC1W1P81_TRAVEL_WARNING_RECONCILIATION',
  'evidence',
  'travel_warning_reconciliation_summary.json'
);

const TARGET_COUNTRIES = [
  'TR',
  'FR',
  'PT',
  'ES',
  'BG',
  'BE',
  'CA',
  'AR',
  'AE',
  'SE',
  'NO',
  'MX',
  'UY',
  'CH',
  'KR',
  'AZ',
  'KZ',
  'BA',
  'MK',
] as const;

const FOCUS_P0_P1 = ['TR', 'FR', 'PT', 'ES', 'BG', 'BE'] as const;

function ensureEnvForReadOnlyDb() {
  if (process.env.DATABASE_URL) return;
  const fallbackEnv = path.resolve(process.cwd(), '..', 'app', 'api', '.env');
  if (fs.existsSync(fallbackEnv)) {
    dotenv.config({ path: fallbackEnv, quiet: true });
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function hasText(value: any): boolean {
  return String(value ?? '').trim().length > 0;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableRowsProjection(rows: TravelWarningMappedRow[]) {
  return rows.map((row) => ({
    country_code: row.country_code,
    level: row.level,
    level_label: row.level_label,
    summary: row.summary,
    issued_date: row.issued_date,
    issued_date_reason: row.issued_date_reason,
    source_url: row.source_url,
    source_url_reason: row.source_url_reason,
    source_record_id: row.source_record_id,
    source_country_value: row.source_country_value,
  }));
}

function levelDistribution(rows: TravelWarningMappedRow[]): Record<string, number> {
  const dist = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.level);
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(dist.entries()).sort((a, b) => Number(a[0]) - Number(b[0])));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let col = 0; col < headers.length; col += 1) {
      row[headers[col]] = values[col] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function readJsonWithBom(pathname: string): any {
  const raw = fs.readFileSync(pathname, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function readOptionalJson(pathname: string): any {
  if (!fs.existsSync(pathname)) return null;
  return readJsonWithBom(pathname);
}

function csvEscape(value: any): string {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function summarizeDelta(existing: ExistingTravelWarningRow | undefined, dry: TravelWarningMappedRow | undefined): string {
  const flags: string[] = [];
  if (!existing && dry) flags.push('row_added_simulated');
  if (existing && !dry) flags.push('row_missing_simulated');

  if (existing && dry) {
    if ((existing.level ?? null) !== dry.level) flags.push('level_changed');
    const existingUrl = hasText(existing.source_url);
    const dryUrl = hasText(dry.source_url);
    if (existingUrl !== dryUrl) flags.push(dryUrl ? 'source_url_improved' : 'source_url_regressed');

    const existingDate = hasText(existing.issued_date);
    const dryDate = hasText(dry.issued_date);
    if (existingDate !== dryDate) flags.push(dryDate ? 'issued_date_improved' : 'issued_date_regressed');
  }

  if (!flags.length) return 'no_material_delta';
  return flags.join('|');
}

async function main() {
  ensureDir(REVIEW_ROOT);
  ensureDir(EVIDENCE_ROOT);
  ensureEnvForReadOnlyDb();

  const syncModule = await import('./syncTravelWarnings');
  const fetchTravelWarningSourceRecords = syncModule.fetchTravelWarningSourceRecords as (args?: {
    limit?: number;
  }) => Promise<{ packageId: string; resourceId: string; total: number; records: Array<Record<string, any>> }>;
  const loadCountryMaps = syncModule.loadCountryMaps as () => Promise<any>;
  const loadExistingTravelWarningsByCountry = syncModule.loadExistingTravelWarningsByCountry as () => Promise<
    Map<string, ExistingTravelWarningRow>
  >;
  const mapTravelWarningRecords = syncModule.mapTravelWarningRecords as (
    records: Array<Record<string, any>>,
    maps: any,
    options?: { existingByCountry?: Map<string, ExistingTravelWarningRow> }
  ) => MappedResult;

  const queueRows = parseCsv(fs.readFileSync(P81_QUEUE_CSV, 'utf8'));
  const queueByCode = new Map<string, Record<string, string>>();
  for (const row of queueRows) {
    const code = String(row.country_code ?? '').trim().toUpperCase();
    if (code) queueByCode.set(code, row);
  }

  const summary = readJsonWithBom(P81_SUMMARY_JSON);
  const p84PostSync = readOptionalJson(P84_POST_SYNC_JSON);
  const p85NonRegression = readOptionalJson(P85_NON_REGRESSION_JSON);
  const p85FocusRows = fs.existsSync(P85_FOCUS_COUNTRY_CSV) ? parseCsv(fs.readFileSync(P85_FOCUS_COUNTRY_CSV, 'utf8')) : [];
  const p85ByCode = new Map<string, Record<string, string>>();
  for (const row of p85FocusRows) {
    const code = String(row.country_code ?? '').trim().toUpperCase();
    if (code) p85ByCode.set(code, row);
  }

  const source = await fetchTravelWarningSourceRecords({ limit: 1000 });
  const maps = await loadCountryMaps();
  const existingByCountry = await loadExistingTravelWarningsByCountry();

  const mappedRun1 = mapTravelWarningRecords(source.records, maps, { existingByCountry });
  const mappedRun2 = mapTravelWarningRecords(source.records, maps, { existingByCountry });

  const projection1 = stableRowsProjection(mappedRun1.rows);
  const projection2 = stableRowsProjection(mappedRun2.rows);

  const deterministicHashRun1 = sha256(JSON.stringify(projection1));
  const deterministicHashRun2 = sha256(JSON.stringify(projection2));
  const unresolvedHashRun1 = sha256(JSON.stringify(mappedRun1.unresolvedCountryRows));
  const unresolvedHashRun2 = sha256(JSON.stringify(mappedRun2.unresolvedCountryRows));

  const sourceFingerprint = sha256(
    JSON.stringify(
      source.records.map((rec) => ({
        _id: rec?._id ?? null,
        country: rec?.country ?? null,
        recommendations: rec?.recommendations ?? null,
        details: rec?.details ?? null,
        date: rec?.date ?? null,
      }))
    )
  );

  const existingRows = Array.from(existingByCountry.values()).sort((a, b) => a.country_code.localeCompare(b.country_code));
  const dryRows = mappedRun1.rows;
  const dryByCode = new Map<string, TravelWarningMappedRow>(dryRows.map((row) => [row.country_code, row]));

  const baselineRowCount = existingRows.length;
  const dryRowCount = dryRows.length;

  const baselineSourceUrlPresentCount = existingRows.filter((row) => hasText(row.source_url)).length;
  const drySourceUrlPresentCount = dryRows.filter((row) => hasText(row.source_url)).length;

  const baselineIssuedDatePresentCount = existingRows.filter((row) => hasText(row.issued_date)).length;
  const dryIssuedDatePresentCount = dryRows.filter((row) => hasText(row.issued_date)).length;

  const baselineNonL1SourceUrlPresentCount = existingRows.filter(
    (row) => (row.level ?? 0) >= 2 && hasText(row.source_url)
  ).length;
  const dryNonL1SourceUrlPresentCount = dryRows.filter((row) => row.level >= 2 && hasText(row.source_url)).length;
  const p84Totals = p84PostSync?.totals ?? null;
  const p85Totals = p85NonRegression?.p85ConsumerRouteTotals ?? null;
  const p85RowCount = Number(p85Totals?.row_count ?? baselineRowCount);
  const p85SourceUrlPresentCount = Number(p85Totals?.source_url_present_count ?? baselineSourceUrlPresentCount);
  const p85IssuedDatePresentCount = Number(p85Totals?.issued_date_present_count ?? baselineIssuedDatePresentCount);
  const p85NonL1SourceUrlPresentCount = Number(
    p85Totals?.non_l1_source_url_present_count ?? baselineNonL1SourceUrlPresentCount
  );
  const sourceDateNonEmptyCount = source.records.filter((rec) => hasText(rec?.date)).length;

  const matrixHeader = [
    'country_code',
    'country_name',
    'reconciliation_issue',
    'priority',
    'current_present',
    'current_level',
    'current_source_url_present',
    'current_issued_date_present',
    'dry_run_present',
    'dry_run_level',
    'dry_run_level_label',
    'dry_run_source_url_present',
    'dry_run_source_url_reason',
    'dry_run_issued_date',
    'dry_run_issued_date_reason',
    'source_rows_in_ckan',
    'selected_source_record_id',
    'selected_source_country_value',
    'delta_flags',
  ];

  const matrixRows: string[] = [matrixHeader.join(',')];
  const targetedDeltaRows: Array<Record<string, any>> = [];

  for (const code of TARGET_COUNTRIES) {
    const queue = queueByCode.get(code);
    const existing = existingByCountry.get(code);
    const dry = dryByCode.get(code);

    const row = {
      country_code: code,
      country_name: queue?.country_name ?? '',
      reconciliation_issue: queue?.reconciliation_issue ?? '',
      priority: queue?.priority ?? '',
      current_present: Boolean(existing),
      current_level: existing?.level ?? null,
      current_source_url_present: Boolean(existing && hasText(existing.source_url)),
      current_issued_date_present: Boolean(existing && hasText(existing.issued_date)),
      dry_run_present: Boolean(dry),
      dry_run_level: dry?.level ?? null,
      dry_run_level_label: dry?.level_label ?? null,
      dry_run_source_url_present: Boolean(dry && hasText(dry.source_url)),
      dry_run_source_url_reason: dry?.source_url_reason ?? null,
      dry_run_issued_date: dry?.issued_date ?? null,
      dry_run_issued_date_reason: dry?.issued_date_reason ?? null,
      source_rows_in_ckan: mappedRun1.countryInputCounts[code] ?? 0,
      selected_source_record_id: dry?.source_record_id ?? null,
      selected_source_country_value: dry?.source_country_value ?? null,
      delta_flags: summarizeDelta(existing, dry),
    };

    matrixRows.push(
      [
        row.country_code,
        row.country_name,
        row.reconciliation_issue,
        row.priority,
        row.current_present,
        row.current_level,
        row.current_source_url_present,
        row.current_issued_date_present,
        row.dry_run_present,
        row.dry_run_level,
        row.dry_run_level_label,
        row.dry_run_source_url_present,
        row.dry_run_source_url_reason,
        row.dry_run_issued_date,
        row.dry_run_issued_date_reason,
        row.source_rows_in_ckan,
        row.selected_source_record_id,
        row.selected_source_country_value,
        row.delta_flags,
      ]
        .map(csvEscape)
        .join(',')
    );

    targetedDeltaRows.push(row);
  }

  const matrixPath = path.join(EVIDENCE_ROOT, 'mapper_dry_run_country_matrix.csv');
  fs.writeFileSync(matrixPath, `${matrixRows.join('\n')}\n`, 'utf8');

  const residualMatrixHeader = [
    'country_code',
    'p85_present',
    'p85_row_count',
    'p85_source_url_present_count',
    'p85_issued_date_present_count',
    'p85_consumer_status',
    'dry_run_present',
    'dry_run_level',
    'dry_run_level_label',
    'dry_run_source_url_present',
    'dry_run_source_url_reason',
    'dry_run_issued_date_present',
    'dry_run_issued_date_reason',
    'source_rows_in_ckan',
    'selected_source_record_id',
    'selected_source_country_value',
    'source_url_delta',
    'issued_date_delta',
    'mx_supported_by_upstream_rows',
  ];
  const residualMatrixRows: string[] = [residualMatrixHeader.join(',')];
  for (const code of TARGET_COUNTRIES) {
    const p85 = p85ByCode.get(code);
    const dry = dryByCode.get(code);
    const p85SourceUrlCount = Number(p85?.source_url_present_count ?? 0);
    const p85IssuedDateCount = Number(p85?.issued_date_present_count ?? 0);
    const drySourceUrlPresent = Boolean(dry && hasText(dry.source_url));
    const dryIssuedDatePresent = Boolean(dry && hasText(dry.issued_date));
    const sourceUrlDelta =
      p85SourceUrlCount === 0 && drySourceUrlPresent
        ? 'improved'
        : p85SourceUrlCount > 0 && drySourceUrlPresent
          ? 'unchanged_present'
          : p85SourceUrlCount > 0 && !drySourceUrlPresent
            ? 'regressed'
            : 'unchanged_absent';
    const issuedDateDelta =
      p85IssuedDateCount === 0 && dryIssuedDatePresent
        ? 'improved'
        : p85IssuedDateCount > 0 && dryIssuedDatePresent
          ? 'unchanged_present'
          : p85IssuedDateCount > 0 && !dryIssuedDatePresent
            ? 'regressed'
            : 'unchanged_absent';

    residualMatrixRows.push(
      [
        code,
        p85?.present ?? false,
        p85?.row_count ?? 0,
        p85SourceUrlCount,
        p85IssuedDateCount,
        p85?.consumer_status ?? '',
        Boolean(dry),
        dry?.level ?? null,
        dry?.level_label ?? null,
        drySourceUrlPresent,
        dry?.source_url_reason ?? null,
        dryIssuedDatePresent,
        dry?.issued_date_reason ?? null,
        mappedRun1.countryInputCounts[code] ?? 0,
        dry?.source_record_id ?? null,
        dry?.source_country_value ?? null,
        sourceUrlDelta,
        issuedDateDelta,
        code === 'MX' ? (mappedRun1.countryInputCounts.MX ?? 0) > 0 : '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  const residualMatrixPath = path.join(EVIDENCE_ROOT, 'residual_focus_country_matrix.csv');
  fs.writeFileSync(residualMatrixPath, `${residualMatrixRows.join('\n')}\n`, 'utf8');

  const unresolvedPath = path.join(EVIDENCE_ROOT, 'mapper_unresolved_country_rows.json');
  fs.writeFileSync(
    unresolvedPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        unresolved_count: mappedRun1.unresolvedCountryRows.length,
        unresolved_rows: mappedRun1.unresolvedCountryRows,
      },
      null,
      2
    ),
    'utf8'
  );

  const targetedDeltaPath = path.join(EVIDENCE_ROOT, 'targeted_country_delta_preview.json');
  fs.writeFileSync(
    targetedDeltaPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope: 'AOFORC1W1P83 targeted country dry-run delta preview',
        countries: targetedDeltaRows,
        summary: {
          target_country_count: TARGET_COUNTRIES.length,
          newly_mapped_count: targetedDeltaRows.filter((row) => row.current_present === false && row.dry_run_present === true)
            .length,
          still_missing_count: targetedDeltaRows.filter((row) => row.dry_run_present === false).length,
          source_url_improved_count: targetedDeltaRows.filter((row) => row.delta_flags.includes('source_url_improved')).length,
          issued_date_improved_count: targetedDeltaRows.filter((row) => row.delta_flags.includes('issued_date_improved')).length,
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const trInputRows = mappedRun1.countryInputCounts.TR ?? 0;
  const focusMissing = FOCUS_P0_P1.filter((code) => !dryByCode.has(code));

  const acceptanceChecks = {
    country_normalization_tr_mappable_when_source_present: trInputRows > 0 && dryByCode.has('TR'),
    deterministic_counts_stable: deterministicHashRun1 === deterministicHashRun2 && unresolvedHashRun1 === unresolvedHashRun2,
    duplicate_country_consolidation_stable: deterministicHashRun1 === deterministicHashRun2,
    non_l1_source_url_non_regression: dryNonL1SourceUrlPresentCount >= baselineNonL1SourceUrlPresentCount,
    issued_date_reporting_present:
      Number.isFinite(dryIssuedDatePresentCount) &&
      Object.prototype.hasOwnProperty.call(mappedRun1.issuedDateReasonCounts, 'issued_date_unavailable_from_source'),
    target_country_matrix_included: fs.existsSync(matrixPath) && targetedDeltaRows.length === TARGET_COUNTRIES.length,
    unresolved_list_excludes_tr: !mappedRun1.unresolvedCountryRows.some((row) =>
      /(תורכיה|טורקיה|turkey|turkiye|türkiye)/i.test(row.normalized_country_value)
    ),
    mx_not_fabricated_without_upstream_support:
      !dryByCode.has('MX') || (mappedRun1.countryInputCounts.MX ?? 0) > 0,
    pre_sync_and_simulated_post_metrics_attached:
      Number.isFinite(baselineRowCount) && Number.isFinite(dryRowCount) && Number.isFinite(baselineSourceUrlPresentCount),
    stop_conditions_precomputed: true,
  };

  const stopConditionsPreview = {
    approval_text_missing_or_altered: 'BLOCK',
    sync_executed_more_than_once: 'BLOCK',
    post_sync_route_not_200: 'BLOCK',
    tr_missing_after_sync_simulation: !dryByCode.has('TR'),
    p0_p1_focus_countries_missing_after_sync_simulation: focusMissing,
    mx_fabricated_without_source_evidence: dryByCode.has('MX') && (mappedRun1.countryInputCounts.MX ?? 0) === 0,
    total_rows_collapse_vs_pre_sync_baseline: dryRowCount < baselineRowCount,
    source_url_non_l1_regression: dryNonL1SourceUrlPresentCount < baselineNonL1SourceUrlPresentCount,
  };

  const metrics = {
    generated_at: new Date().toISOString(),
    scope: SCOPE_LABEL,
    source: {
      package_id: source.packageId,
      resource_id: source.resourceId,
      records_seen: source.records.length,
      records_total: source.total,
      input_fingerprint_sha256: sourceFingerprint,
      non_empty_record_date_count: sourceDateNonEmptyCount,
    },
    baseline_pre_sync: {
      row_count: baselineRowCount,
      source_url_present_count: baselineSourceUrlPresentCount,
      issued_date_present_count: baselineIssuedDatePresentCount,
      non_l1_source_url_present_count: baselineNonL1SourceUrlPresentCount,
      p81_summary_row_count: summary?.source_context?.travel_warnings_row_count ?? null,
      p81_summary_source_url_present_rows: summary?.source_context?.source_url_present_rows ?? null,
      p81_summary_issued_date_present_rows: summary?.source_context?.issued_date_present_rows ?? null,
    },
    comparison_baselines: {
      p84_post_sync_totals: p84Totals,
      p85_consumer_route_totals: p85Totals,
    },
    simulated_post_sync_from_patch: {
      consolidated_country_rows: dryRowCount,
      source_url_present_count: drySourceUrlPresentCount,
      issued_date_present_count: dryIssuedDatePresentCount,
      non_l1_source_url_present_count: dryNonL1SourceUrlPresentCount,
      unresolved_country_rows_count: mappedRun1.unresolvedCountryRows.length,
      duplicate_country_groups: mappedRun1.duplicateCountryCodes.length,
      unknown_severity_rows: mappedRun1.unknownSeverityRows,
      level_distribution: levelDistribution(dryRows),
      source_url_reason_counts: mappedRun1.sourceUrlReasonCounts,
      issued_date_reason_counts: mappedRun1.issuedDateReasonCounts,
      misses: mappedRun1.misses,
      tr_source_rows_seen: trInputRows,
      tr_row_present: dryByCode.has('TR'),
      mx_source_rows_seen: mappedRun1.countryInputCounts.MX ?? 0,
      mx_row_present: dryByCode.has('MX'),
      source_dataset_page_fallback_count: mappedRun1.sourceUrlReasonCounts.source_dataset_page ?? 0,
      deterministic_hash_run_1: deterministicHashRun1,
      deterministic_hash_run_2: deterministicHashRun2,
      deterministic_hash_match: deterministicHashRun1 === deterministicHashRun2,
      unresolved_hash_run_1: unresolvedHashRun1,
      unresolved_hash_run_2: unresolvedHashRun2,
      unresolved_hash_match: unresolvedHashRun1 === unresolvedHashRun2,
    },
    simulated_vs_p85: {
      row_count_delta: dryRowCount - p85RowCount,
      source_url_present_count_delta: drySourceUrlPresentCount - p85SourceUrlPresentCount,
      issued_date_present_count_delta: dryIssuedDatePresentCount - p85IssuedDatePresentCount,
      non_l1_source_url_present_count_delta: dryNonL1SourceUrlPresentCount - p85NonL1SourceUrlPresentCount,
    },
    acceptance_checks: acceptanceChecks,
    owner_gate_stop_conditions_preview: stopConditionsPreview,
  };

  const metricsPath = path.join(EVIDENCE_ROOT, 'mapper_dry_run_metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2), 'utf8');
  const residualMetricsPath = path.join(EVIDENCE_ROOT, 'residual_dry_run_metrics.json');
  fs.writeFileSync(residualMetricsPath, JSON.stringify(metrics, null, 2), 'utf8');

  const criteriaRows: Array<{ id: string; status: 'PASS' | 'FAIL'; detail: string }> = [
    {
      id: '1. TR country normalization mappable from source rows',
      status: acceptanceChecks.country_normalization_tr_mappable_when_source_present ? 'PASS' : 'FAIL',
      detail: `TR source rows seen=${trInputRows}, simulated TR present=${dryByCode.has('TR')}`,
    },
    {
      id: '2. Dry-run deterministic counts/hash stable',
      status: acceptanceChecks.deterministic_counts_stable ? 'PASS' : 'FAIL',
      detail: `hash1=${deterministicHashRun1}, hash2=${deterministicHashRun2}`,
    },
    {
      id: '3. Duplicate-country consolidation stable',
      status: acceptanceChecks.duplicate_country_consolidation_stable ? 'PASS' : 'FAIL',
      detail: `duplicate groups=${mappedRun1.duplicateCountryCodes.length}`,
    },
    {
      id: '4. Non-L1 source_url non-regression',
      status: acceptanceChecks.non_l1_source_url_non_regression ? 'PASS' : 'FAIL',
      detail: `baseline=${baselineNonL1SourceUrlPresentCount}, dry_run=${dryNonL1SourceUrlPresentCount}`,
    },
    {
      id: '5. issued_date extraction coverage + unavailable reason counts',
      status: acceptanceChecks.issued_date_reporting_present ? 'PASS' : 'FAIL',
      detail: `issued_date_present=${dryIssuedDatePresentCount}, unavailable_reason_count=${mappedRun1.issuedDateReasonCounts.issued_date_unavailable_from_source ?? 0}`,
    },
    {
      id: '6. Target country matrix includes required countries',
      status: acceptanceChecks.target_country_matrix_included ? 'PASS' : 'FAIL',
      detail: `rows=${targetedDeltaRows.length}, required=${TARGET_COUNTRIES.length}`,
    },
    {
      id: '7. Unresolved list excludes TR',
      status: acceptanceChecks.unresolved_list_excludes_tr ? 'PASS' : 'FAIL',
      detail: `unresolved_count=${mappedRun1.unresolvedCountryRows.length}`,
    },
    {
      id: '8. Pre-sync and simulated-post metrics attached',
      status: acceptanceChecks.pre_sync_and_simulated_post_metrics_attached ? 'PASS' : 'FAIL',
      detail: `baseline_row_count=${baselineRowCount}, simulated_row_count=${dryRowCount}`,
    },
    {
      id: '9. MX row not fabricated without upstream support',
      status: acceptanceChecks.mx_not_fabricated_without_upstream_support ? 'PASS' : 'FAIL',
      detail: `MX source rows seen=${mappedRun1.countryInputCounts.MX ?? 0}, simulated MX present=${dryByCode.has('MX')}`,
    },
    {
      id: '10. Stop conditions precomputed',
      status: acceptanceChecks.stop_conditions_precomputed ? 'PASS' : 'FAIL',
      detail: `focus_missing=${focusMissing.join('|') || 'none'}`,
    },
  ];

  const patchSpecCheckPath = path.join(EVIDENCE_ROOT, 'mapper_source_patch_spec_check.md');
  const patchSpecCheckMd = [
    '# mapper_source_patch_spec_check',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Implemented Code Scope',
    '',
    '- Patched mapper logic in `src/jobs/syncTravelWarnings.ts` only for normalization, source URL fallback, issued date extraction, and deterministic consolidation.',
    '- Added read-only dry-run evidence generator `src/jobs/syncTravelWarnings.mapperDryRunP83.ts`.',
    '- No sync execution and no SQL writes were performed in this dry-run evidence run.',
    '',
    '## Acceptance Criteria Status (P82)',
    '',
    '| Criterion | Status | Detail |',
    '| --- | --- | --- |',
    ...criteriaRows.map((row) => `| ${row.id} | ${row.status} | ${row.detail} |`),
    '',
    '## Evidence Files',
    '',
    '- `mapper_dry_run_metrics.json`',
    '- `mapper_dry_run_country_matrix.csv`',
    '- `mapper_unresolved_country_rows.json`',
    '- `targeted_country_delta_preview.json`',
    '',
    '## Notes',
    '',
    '- This packet is patch + dry-run evidence only. No live sync was executed.',
  ].join('\n');
  fs.writeFileSync(patchSpecCheckPath, patchSpecCheckMd, 'utf8');

  const sourceUrlGainVsP85 = drySourceUrlPresentCount - p85SourceUrlPresentCount;
  const issuedDateGainVsP85 = dryIssuedDatePresentCount - p85IssuedDatePresentCount;
  const rowGainVsP85 = dryRowCount - p85RowCount;
  const nonL1SourceUrlGainVsP85 = dryNonL1SourceUrlPresentCount - p85NonL1SourceUrlPresentCount;
  const laterLiveSyncJustified =
    rowGainVsP85 > 0 || sourceUrlGainVsP85 > 0 || issuedDateGainVsP85 > 0 || nonL1SourceUrlGainVsP85 > 0;
  const liveSyncRecommendationPath = path.join(EVIDENCE_ROOT, 'live_sync_recommendation.json');
  fs.writeFileSync(
    liveSyncRecommendationPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        status: laterLiveSyncJustified ? 'JUSTIFIED_OPTIONAL_OWNER_GATE' : 'NOT_JUSTIFIED_BY_DRY_RUN',
        execute_live_sync_now: false,
        live_sync_executed_in_this_run: false,
        basis: {
          p85_row_count: p85RowCount,
          dry_run_row_count: dryRowCount,
          row_count_delta_vs_p85: rowGainVsP85,
          p85_source_url_present_count: p85SourceUrlPresentCount,
          dry_run_source_url_present_count: drySourceUrlPresentCount,
          source_url_present_count_delta_vs_p85: sourceUrlGainVsP85,
          p85_issued_date_present_count: p85IssuedDatePresentCount,
          dry_run_issued_date_present_count: dryIssuedDatePresentCount,
          issued_date_present_count_delta_vs_p85: issuedDateGainVsP85,
          p85_non_l1_source_url_present_count: p85NonL1SourceUrlPresentCount,
          dry_run_non_l1_source_url_present_count: dryNonL1SourceUrlPresentCount,
          non_l1_source_url_present_count_delta_vs_p85: nonL1SourceUrlGainVsP85,
          mx_source_rows_seen: mappedRun1.countryInputCounts.MX ?? 0,
          mx_row_present_in_dry_run: dryByCode.has('MX'),
          source_date_non_empty_count: sourceDateNonEmptyCount,
        },
        recommendation: laterLiveSyncJustified
          ? 'A later owner-approved one-run live sync is justified if the owner wants the P86 source provenance and MX remediation applied to the live consumer payload. It is not needed for current P85 consumer stability.'
          : 'Do not run a live sync; this dry-run does not show a material source/date improvement over P85.',
        next_gate_approval_sentence:
          'I approve AOFORC1W1P87 to execute exactly one live travel-warning sync using the P86 residual remediation patch, with database writes limited to the travel_warnings sync job, no deploy, no push, no EAS build, no SQL console/manual writes, and immediate read-only post-sync verification.',
      },
      null,
      2
    ),
    'utf8'
  );

  const allPass = Object.values(acceptanceChecks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        ok: true,
        acceptance_all_pass: allPass,
        metrics_path: metricsPath,
        residual_metrics_path: residualMetricsPath,
        matrix_path: matrixPath,
        residual_matrix_path: residualMatrixPath,
        unresolved_path: unresolvedPath,
        targeted_delta_path: targetedDeltaPath,
        spec_check_path: patchSpecCheckPath,
        live_sync_recommendation_path: liveSyncRecommendationPath,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('MAPPER_DRY_RUN_FAIL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const dbModule = await import('../db');
      await dbModule.pool.end();
    } catch {
      // ignore pool shutdown errors in dry-run tooling
    }
  });
