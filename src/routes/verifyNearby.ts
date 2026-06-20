import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { assertRequestedUserMatchesAuthenticated, requireAuthenticatedUser } from '../auth';

const router = Router();

const VERIFIER_CHOICES = new Set(['i_was_there', 'not_sure', 'skip']);
const WHEN_APPROX_VALUES = new Set(['within_window', 'earlier', 'later', 'not_sure']);
const WHERE_APPROX_VALUES = new Set(['city_only', 'area', 'very_near']);
const TIME_FILTER_VALUES = new Set(['today', 'yesterday', '7_days', 'pick_a_date']);

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 200;
const EXCERPT_MAX_LENGTH = 220;

type VerifyNearbyVerificationResult =
  | 'cross_validated'
  | 'supporting_only'
  | 'ignored';

interface CandidateQueryRow {
  testimony_id: string;
  submission_category: string;
  incident_type: string;
  status: string;
  coarse_city: string | null;
  coarse_area: string | null;
  country_code: string | null;
  date_occurred: Date | string | null;
  body: string | null;
  evidence_note: string | null;
  source_url: string | null;
  incident_id: string | null;
  created_at: string;
  updated_at: string;
  cross_validated: boolean;
  supporting_only: boolean;
  report_issue_status: string | null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value) && value.length > 0) {
    return readOptionalString(value[0]);
  }
  return null;
}

function readRequiredString(value: unknown): string | null {
  return readOptionalString(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sanitizeExcerpt(body: string | null): string {
  if (!body) return '';
  return body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX_LENGTH);
}

function normalizeDateOutput(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseLimitParam(value: unknown): number | null {
  const raw = readOptionalString(value);
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_LIMIT);
}

function parseRadiusParam(value: unknown): number | null {
  const raw = readOptionalString(value);
  if (!raw) return DEFAULT_RADIUS_KM;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_RADIUS_KM);
}

function mapVerificationResult(choice: string): VerifyNearbyVerificationResult {
  switch (choice) {
    case 'i_was_there':
      return 'cross_validated';
    case 'not_sure':
      return 'supporting_only';
    default:
      return 'ignored';
  }
}

function deriveVerificationStatus(row: CandidateQueryRow): string {
  if (row.cross_validated) return 'cross_validated';
  if (row.supporting_only) return 'supporting_only';
  return 'pending';
}

function deriveVerificationMethod(
  verificationStatus: string,
  sourceUrl: string | null,
  evidenceNote: string | null
): string {
  if (verificationStatus === 'cross_validated') return 'cross_witness';
  if (sourceUrl) return 'linked_source';
  if (evidenceNote) return 'evidence';
  return 'unverified';
}

function dateWindowLabel(timeFilter: string | null): string {
  switch (timeFilter) {
    case 'today':
      return 'today';
    case 'yesterday':
      return 'yesterday';
    case '7_days':
      return 'last_7_days';
    case 'pick_a_date':
      return 'picked_date';
    default:
      return 'reported_date';
  }
}

async function loadTestimonyIdentity(testimonyId: string): Promise<{ id: string; user_id: string | null } | null> {
  const { rows } = await pool.query<{ id: string; user_id: string | null }>(
    'SELECT id, user_id FROM testimonies WHERE id = $1 LIMIT 1',
    [testimonyId]
  );
  return rows[0] ?? null;
}

// GET /api/verify-nearby/candidates
router.get('/candidates', async (req: Request, res: Response) => {
  const authenticatedUserId = requireAuthenticatedUser(req, res);
  if (!authenticatedUserId) return;

  const userId = readRequiredString(req.query.user_id);
  const cityOrPlace = readOptionalString(req.query.city_or_place);
  const countryCodeRaw = readOptionalString(req.query.country_code);
  const timeFilter = readOptionalString(req.query.time_filter);
  const pickedDate = readOptionalString(req.query.date);
  const limit = parseLimitParam(req.query.limit);
  const radiusKm = parseRadiusParam(req.query.radius_km);

  if (!userId) {
    res.status(400).json({ error: 'Missing user_id query parameter' });
    return;
  }
  if (!assertRequestedUserMatchesAuthenticated(res, userId, authenticatedUserId)) return;
  if (limit === null) {
    res.status(400).json({ error: 'limit must be a positive integer' });
    return;
  }
  if (radiusKm === null) {
    res.status(400).json({ error: 'radius_km must be a positive number' });
    return;
  }
  if (timeFilter && !TIME_FILTER_VALUES.has(timeFilter)) {
    res.status(400).json({ error: 'time_filter must be one of today, yesterday, 7_days, pick_a_date' });
    return;
  }
  if (timeFilter === 'pick_a_date' && (!pickedDate || !isIsoDateOnly(pickedDate))) {
    res.status(400).json({ error: 'date (YYYY-MM-DD) is required for pick_a_date' });
    return;
  }

  const countryCode = countryCodeRaw ? countryCodeRaw.toUpperCase() : null;
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
    res.status(400).json({ error: 'country_code must be uppercase ISO-2' });
    return;
  }

  const whereClauses = [
    "t.status = 'pending'",
    't.user_id <> $1',
    `NOT EXISTS (
      SELECT 1
      FROM testimony_verification_actions existing_verify
      WHERE existing_verify.testimony_id = t.id
        AND existing_verify.verifier_user_id = $1
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM testimony_report_issue_actions existing_report
      WHERE existing_report.testimony_id = t.id
        AND existing_report.reporter_user_id = $1
    )`,
    "NULLIF(btrim(t.submission_category), '') IS NOT NULL",
    "NULLIF(btrim(t.incident_type), '') IS NOT NULL",
    't.date_occurred IS NOT NULL',
    "NULLIF(btrim(t.coarse_city), '') IS NOT NULL",
    "NULLIF(btrim(t.country_code), '') IS NOT NULL",
  ];

  const params: unknown[] = [userId];

  if (cityOrPlace) {
    params.push(`%${cityOrPlace.toLowerCase()}%`);
    const cityParam = `$${params.length}`;
    whereClauses.push(`(
      LOWER(COALESCE(t.coarse_city, '')) LIKE ${cityParam}
      OR LOWER(COALESCE(t.coarse_area, '')) LIKE ${cityParam}
    )`);
  }

  if (countryCode) {
    params.push(countryCode);
    whereClauses.push(`t.country_code = $${params.length}`);
  }

  if (timeFilter === 'today') {
    whereClauses.push('DATE(t.date_occurred) = CURRENT_DATE');
  } else if (timeFilter === 'yesterday') {
    whereClauses.push("DATE(t.date_occurred) = (CURRENT_DATE - INTERVAL '1 day')");
  } else if (timeFilter === '7_days') {
    whereClauses.push("DATE(t.date_occurred) >= (CURRENT_DATE - INTERVAL '7 day')");
  } else if (timeFilter === 'pick_a_date' && pickedDate) {
    params.push(pickedDate);
    whereClauses.push(`DATE(t.date_occurred) = $${params.length}`);
  }

  params.push(limit);
  const limitPlaceholder = `$${params.length}`;

  try {
    const { rows } = await pool.query<CandidateQueryRow>(
      `SELECT
         t.id AS testimony_id,
         t.submission_category,
         t.incident_type,
         t.status,
         t.coarse_city,
         t.coarse_area,
         t.country_code,
         t.date_occurred,
         t.body,
         t.evidence_note,
         t.source_url,
         t.incident_id,
         t.created_at::text AS created_at,
         t.updated_at::text AS updated_at,
         COALESCE(v.cross_validated, FALSE) AS cross_validated,
         COALESCE(v.supporting_only, FALSE) AS supporting_only,
         COALESCE(r.report_issue_status, 'none') AS report_issue_status
       FROM testimonies t
       LEFT JOIN LATERAL (
         SELECT
           BOOL_OR(a.verifier_choice = 'i_was_there' AND a.verifier_user_id <> t.user_id) AS cross_validated,
           BOOL_OR(a.verifier_choice = 'not_sure' AND a.verifier_user_id <> t.user_id) AS supporting_only
         FROM testimony_verification_actions a
         WHERE a.testimony_id = t.id
       ) v ON TRUE
       LEFT JOIN LATERAL (
         SELECT ra.status AS report_issue_status
         FROM testimony_report_issue_actions ra
         WHERE ra.testimony_id = t.id
         ORDER BY ra.created_at DESC
         LIMIT 1
       ) r ON TRUE
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT ${limitPlaceholder}`,
      params
    );

    const timeLabel = dateWindowLabel(timeFilter);
    const candidates = rows.map((row) => {
      const verificationStatus = deriveVerificationStatus(row);
      const normalizedDate = normalizeDateOutput(row.date_occurred);

      return {
        id: row.testimony_id,
        testimony_id: row.testimony_id,
        submission_category: row.submission_category,
        incident_type: row.incident_type,
        status: row.status,
        location: {
          city: row.coarse_city,
          area: row.coarse_area,
          country_code: row.country_code,
        },
        time_window: {
          start: normalizedDate,
          end: normalizedDate,
          label: timeLabel,
        },
        short_excerpt: sanitizeExcerpt(row.body),
        evidence_marker: row.evidence_note ? 'provided' : null,
        source_url: row.source_url,
        linked_incident_id: row.incident_id,
        verification_method: deriveVerificationMethod(verificationStatus, row.source_url, row.evidence_note),
        verification_status: verificationStatus,
        report_issue_status: row.report_issue_status ?? 'none',
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    res.json({
      metadata: {
        user_id_contract: 'temporary_query_user_id',
        radius_km: radiusKm,
        radius_mode: 'coarse_only',
        location_precision: 'coarse',
        limit,
        returned: candidates.length,
      },
      candidates,
    });
  } catch (err) {
    console.error('GET /verify-nearby/candidates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/verify-nearby/:testimonyId/verify
router.post('/:testimonyId/verify', async (req: Request, res: Response) => {
  const authenticatedUserId = requireAuthenticatedUser(req, res);
  if (!authenticatedUserId) return;

  const testimonyId = readRequiredString(req.params.testimonyId);
  const userId = readRequiredString(req.body.user_id);
  const verifierChoice = readRequiredString(req.body.verifier_choice);
  const whatDidYouSee = readOptionalString(req.body.what_did_you_see);
  const whenApprox = readOptionalString(req.body.when_approx);
  const whereApprox = readOptionalString(req.body.where_approx);
  const evidenceNote = readOptionalString(req.body.evidence_note);
  const evidenceUrl = readOptionalString(req.body.evidence_url);

  if (!testimonyId || !isUuid(testimonyId)) {
    res.status(400).json({ error: 'Invalid testimonyId' });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: 'Missing user_id' });
    return;
  }
  if (!assertRequestedUserMatchesAuthenticated(res, userId, authenticatedUserId)) return;
  if (!verifierChoice || !VERIFIER_CHOICES.has(verifierChoice)) {
    res.status(400).json({ error: 'verifier_choice must be i_was_there, not_sure, or skip' });
    return;
  }
  if (evidenceUrl && !isHttpUrl(evidenceUrl)) {
    res.status(400).json({ error: 'evidence_url must use http or https' });
    return;
  }

  const needsSupportingFields = verifierChoice !== 'skip';
  if (needsSupportingFields) {
    if (!whatDidYouSee) {
      res.status(400).json({ error: 'what_did_you_see is required for i_was_there and not_sure' });
      return;
    }
    if (!whenApprox || !WHEN_APPROX_VALUES.has(whenApprox)) {
      res.status(400).json({ error: 'when_approx is invalid or missing' });
      return;
    }
    if (!whereApprox || !WHERE_APPROX_VALUES.has(whereApprox)) {
      res.status(400).json({ error: 'where_approx is invalid or missing' });
      return;
    }
  }

  try {
    const testimony = await loadTestimonyIdentity(testimonyId);
    if (!testimony) {
      res.status(404).json({ error: 'Testimony not found' });
      return;
    }
    if (testimony.user_id && testimony.user_id === userId) {
      res.status(403).json({ error: 'Self-verification is not allowed' });
      return;
    }

    const verificationResult = mapVerificationResult(verifierChoice);
    const defaultWhatDidYouSee = needsSupportingFields ? whatDidYouSee : 'skipped_by_user';
    const defaultWhenApprox = needsSupportingFields ? whenApprox : 'not_sure';
    const defaultWhereApprox = needsSupportingFields ? whereApprox : 'city_only';

    const { rows } = await pool.query<{
      id: string;
      testimony_id: string;
      verifier_choice: string;
      verification_result: string;
      created_at: string;
    }>(
      `INSERT INTO testimony_verification_actions (
         testimony_id,
         verifier_user_id,
         verifier_choice,
         verification_result,
         what_did_you_see,
         when_approx,
         where_approx,
         evidence_note,
         evidence_url
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, testimony_id, verifier_choice, verification_result, created_at::text AS created_at`,
      [
        testimonyId,
        userId,
        verifierChoice,
        verificationResult,
        defaultWhatDidYouSee,
        defaultWhenApprox,
        defaultWhereApprox,
        evidenceNote,
        evidenceUrl,
      ]
    );

    res.status(201).json({
      action_id: rows[0].id,
      testimony_id: rows[0].testimony_id,
      verifier_choice: rows[0].verifier_choice,
      verification_result: rows[0].verification_result,
      created_at: rows[0].created_at,
    });
  } catch (err) {
    const maybePgError = err as { code?: string };
    if (maybePgError.code === '23505') {
      res.status(409).json({ error: 'Verification action already exists for this user and testimony' });
      return;
    }
    console.error('POST /verify-nearby/:testimonyId/verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/verify-nearby/:testimonyId/report-issue
router.post('/:testimonyId/report-issue', async (req: Request, res: Response) => {
  const authenticatedUserId = requireAuthenticatedUser(req, res);
  if (!authenticatedUserId) return;

  const testimonyId = readRequiredString(req.params.testimonyId);
  const userId = readRequiredString(req.body.user_id);
  const issueType = readRequiredString(req.body.issue_type);
  const details = readRequiredString(req.body.details);

  if (!testimonyId || !isUuid(testimonyId)) {
    res.status(400).json({ error: 'Invalid testimonyId' });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: 'Missing user_id' });
    return;
  }
  if (!assertRequestedUserMatchesAuthenticated(res, userId, authenticatedUserId)) return;
  if (!issueType) {
    res.status(400).json({ error: 'Missing issue_type' });
    return;
  }
  if (!details) {
    res.status(400).json({ error: 'Missing details' });
    return;
  }

  try {
    const testimony = await loadTestimonyIdentity(testimonyId);
    if (!testimony) {
      res.status(404).json({ error: 'Testimony not found' });
      return;
    }

    const { rows } = await pool.query<{
      id: string;
      testimony_id: string;
      issue_type: string;
      status: string;
      created_at: string;
    }>(
      `INSERT INTO testimony_report_issue_actions (
         testimony_id,
         reporter_user_id,
         issue_type,
         details
       )
       VALUES ($1, $2, $3, $4)
       RETURNING id, testimony_id, issue_type, status, created_at::text AS created_at`,
      [testimonyId, userId, issueType, details]
    );

    res.status(201).json({
      action_id: rows[0].id,
      testimony_id: rows[0].testimony_id,
      issue_type: rows[0].issue_type,
      status: rows[0].status,
      created_at: rows[0].created_at,
    });
  } catch (err) {
    const maybePgError = err as { code?: string };
    if (maybePgError.code === '23505') {
      res.status(409).json({ error: 'Issue already reported for this user, testimony, and issue_type' });
      return;
    }
    console.error('POST /verify-nearby/:testimonyId/report-issue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
