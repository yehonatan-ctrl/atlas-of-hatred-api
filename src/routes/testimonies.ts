import { randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { assertRequestedUserMatchesAuthenticated, requireAuthenticatedUser } from '../auth';

const router = Router();

const SUBMISSION_CATEGORIES = new Set([
  'personal_testimony',
  'eyewitness_with_evidence',
  'news_article_link',
]);

const INCIDENT_TYPES = new Set([
  'verbal_harassment',
  'physical_assault',
  'vandalism',
  'online_threat',
  'institutional_discrimination',
  'other',
]);

function categoryToShareSlugPrefix(category: string): string {
  switch (category) {
    case 'personal_testimony':
      return 'p';
    case 'news_article_link':
      return 'n';
    default:
      return 'e';
  }
}

function readRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalString(value: unknown): string | null {
  return readRequiredString(value);
}

function normalizeCategory(primary: unknown, legacyCategory: unknown): string | null {
  const value = readRequiredString(primary) ?? readRequiredString(legacyCategory);
  if (!value || !SUBMISSION_CATEGORIES.has(value)) return null;
  return value;
}

function normalizeIncidentType(value: unknown): string | null {
  const incidentType = readRequiredString(value);
  if (!incidentType || !INCIDENT_TYPES.has(incidentType)) return null;
  return incidentType;
}

function readBodyText(body: unknown, bodyText: unknown): string | null {
  return readRequiredString(body) ?? readRequiredString(bodyText);
}

function normalizeCountryCode(value: unknown): string | null {
  const countryCode = readRequiredString(value)?.toUpperCase();
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return null;
  return countryCode;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function makeShareSlug(category: string): string {
  return `${categoryToShareSlugPrefix(category)}-${randomBytes(8).toString('hex')}`;
}

// GET /api/testimonies/:incident_id
router.get('/:incident_id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         incident_id,
         body,
         body AS body_text,
         share_slug,
         COALESCE(is_self, CASE
           WHEN share_slug LIKE 'p-%' THEN TRUE
           WHEN share_slug LIKE 'e-%' OR share_slug LIKE 'n-%' THEN FALSE
           ELSE NULL
         END) AS is_self,
         COALESCE(submission_category, CASE
           WHEN share_slug LIKE 'p-%' THEN 'personal_testimony'
           WHEN share_slug LIKE 'e-%' THEN 'eyewitness_with_evidence'
           WHEN share_slug LIKE 'n-%' THEN 'news_article_link'
           ELSE NULL
         END) AS submission_category,
         incident_type,
         date_occurred,
         coarse_city,
         coarse_area,
         country_code,
         evidence_note,
         source_url,
         status,
         created_at,
         updated_at
       FROM testimonies
       WHERE incident_id = $1 AND status = 'approved'
       ORDER BY created_at DESC`,
      [req.params.incident_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /testimonies/:incident_id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/testimonies
router.post('/', async (req: Request, res: Response) => {
  const authenticatedUserId = await requireAuthenticatedUser(req, res);
  if (!authenticatedUserId) return;

  const requestedUserId = readRequiredString(req.body.user_id);
  if (!assertRequestedUserMatchesAuthenticated(res, requestedUserId, authenticatedUserId)) return;

  const userId = authenticatedUserId;
  const bodyText = readBodyText(req.body.body, req.body.body_text);
  const category = normalizeCategory(req.body.submission_category, req.body.category);
  const incidentType = normalizeIncidentType(req.body.incident_type);
  const dateOccurred = readRequiredString(req.body.date_occurred) ?? readRequiredString(req.body.date);
  const coarseCity = readRequiredString(req.body.coarse_city) ?? readRequiredString(req.body.city);
  const coarseArea = readOptionalString(req.body.coarse_area);
  const countryCode = normalizeCountryCode(req.body.country_code);
  const evidenceNote = readOptionalString(req.body.evidence_note);
  const sourceUrl = readOptionalString(req.body.source_url);
  const isPersonal = category === 'personal_testimony';
  const shareSlug = category ? makeShareSlug(category) : null;
  const incidentId = readOptionalString(req.body.incident_id);

  if (!category || !SUBMISSION_CATEGORIES.has(category)) {
    res.status(400).json({ error: 'Invalid testimony submission category' });
    return;
  }
  if (!bodyText) {
    res.status(400).json({ error: 'Missing testimony body' });
    return;
  }
  if (!incidentType) {
    res.status(400).json({ error: 'Invalid or missing incident type' });
    return;
  }
  if (!dateOccurred) {
    res.status(400).json({ error: 'Missing incident date' });
    return;
  }
  if (!coarseCity) {
    res.status(400).json({ error: 'Missing incident city' });
    return;
  }
  if (!countryCode) {
    res.status(400).json({ error: 'Country code must be uppercase ISO-2' });
    return;
  }
  if (sourceUrl && !isHttpUrl(sourceUrl)) {
    res.status(400).json({ error: 'Source URL must use http or https' });
    return;
  }
  if (category === 'eyewitness_with_evidence' && !hasText(evidenceNote) && !hasText(sourceUrl)) {
    res.status(400).json({ error: 'Eyewitness with evidence requires an evidence note or link' });
    return;
  }
  if (category === 'news_article_link' && (!sourceUrl || !isHttpUrl(sourceUrl))) {
    res.status(400).json({ error: 'News/article testimony requires an http or https source link' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (isPersonal) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [userId]);

      const { rows: recentPersonal } = await client.query(
        `SELECT id, created_at, status
         FROM testimonies
         WHERE user_id = $1
           AND (
             submission_category = 'personal_testimony'
             OR is_self IS TRUE
             OR share_slug LIKE 'p-%'
           )
           AND created_at >= NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      );

      if (recentPersonal.length > 0) {
        await client.query('ROLLBACK');
        res.status(429).json({
          error: 'Personal testimony is limited to one submission per account every 24 hours.',
          limit: 'personal_testimony_24h',
          last_submission_at: recentPersonal[0].created_at,
          last_submission_status: recentPersonal[0].status,
        });
        return;
      }
    }

    const { rows } = await client.query(
      `INSERT INTO testimonies (
         incident_id,
         user_id,
         body,
         share_slug,
         status,
         submission_category,
         incident_type,
         is_self,
         date_occurred,
         coarse_city,
         coarse_area,
         country_code,
         evidence_note,
         source_url
       )
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, status`,
      [
        incidentId,
        userId,
        bodyText,
        shareSlug,
        category,
        incidentType,
        isPersonal,
        dateOccurred,
        coarseCity,
        coarseArea,
        countryCode,
        evidenceNote,
        sourceUrl,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('POST /testimonies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
