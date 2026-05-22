import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

const MIRROR_MIGRATION_REQUIRED_ERROR = 'mirror reports migration required';

function isUndefinedTableError(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: string }).code === '42P01'
  );
}

function sendMirrorError(res: Response, err: unknown, fallbackError: string) {
  console.error(err);
  if (isUndefinedTableError(err)) {
    return res.status(500).json({ error: MIRROR_MIGRATION_REQUIRED_ERROR });
  }
  return res.status(500).json({ error: fallbackError });
}

// ── GET /api/mirror/stats ────────────────────────────────────────────────────
// Counts of approved reports grouped by platform and response type.
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [byPlatform, byResponse] = await Promise.all([
      pool.query(`
        SELECT platform, COUNT(*)::int AS count
        FROM social_mirror_reports
        WHERE status = 'approved'
        GROUP BY platform
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT platform_response, COUNT(*)::int AS count
        FROM social_mirror_reports
        WHERE status = 'approved'
        GROUP BY platform_response
        ORDER BY count DESC
      `),
    ]);
    res.json({ by_platform: byPlatform.rows, by_response: byResponse.rows });
  } catch (err) {
    return sendMirrorError(res, err, 'stats failed');
  }
});

// ── GET /api/mirror ──────────────────────────────────────────────────────────
// List approved reports. Supports ?platform=x&limit=50&offset=0&country=XX
router.get('/', async (req: Request, res: Response) => {
  const { platform, country, limit = '50', offset = '0' } = req.query as Record<string, string>;
  const cap = Math.min(parseInt(limit, 10) || 50, 200);
  const off = parseInt(offset, 10) || 0;

  const conditions: string[] = ["status = 'approved'"];
  const params: unknown[] = [];

  if (platform) { params.push(platform);  conditions.push(`platform = $${params.length}`); }
  if (country)  { params.push(country);   conditions.push(`country_iso = $${params.length}`); }

  params.push(cap, off);
  const where = conditions.join(' AND ');

  try {
    const { rows } = await pool.query(
      `SELECT id, submitter_name, platform,
              original_url, original_screenshot_url, original_text, post_date,
              report_filed_date, report_text, report_screenshot_url,
              platform_response, platform_response_text,
              platform_response_screenshot_url, platform_response_date,
              country_iso, submitted_at
       FROM social_mirror_reports
       WHERE ${where}
       ORDER BY submitted_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (err) {
    return sendMirrorError(res, err, 'fetch failed');
  }
});

// ── GET /api/mirror/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, submitter_name, platform,
              original_url, original_screenshot_url, original_text, post_date,
              report_filed_date, report_text, report_screenshot_url,
              platform_response, platform_response_text,
              platform_response_screenshot_url, platform_response_date,
              country_iso, submitted_at
       FROM social_mirror_reports
       WHERE id = $1 AND status = 'approved'`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    return sendMirrorError(res, err, 'fetch failed');
  }
});

// ── POST /api/mirror ─────────────────────────────────────────────────────────
// Submit a new report. Starts as status='pending' awaiting admin approval.
router.post('/', async (req: Request, res: Response) => {
  const {
    submitter_name, submitter_email,
    platform,
    original_url, original_screenshot_url, original_text, post_date,
    report_filed_date, report_text, report_screenshot_url,
    platform_response = 'no_response',
    platform_response_text, platform_response_screenshot_url, platform_response_date,
    country_iso,
  } = req.body;

  // Required field validation
  if (!submitter_name?.trim()) return res.status(400).json({ error: 'submitter_name required' });
  if (!submitter_email?.trim()) return res.status(400).json({ error: 'submitter_email required' });
  if (!platform) return res.status(400).json({ error: 'platform required' });

  const VALID_PLATFORMS = ['facebook', 'x', 'tiktok', 'instagram', 'youtube', 'other'];
  if (!VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` });
  }

  // Must supply at least one piece of evidence
  if (!original_url && !original_screenshot_url && !original_text) {
    return res.status(400).json({ error: 'provide at least one of: original_url, original_screenshot_url, original_text' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO social_mirror_reports
         (submitter_name, submitter_email,
          platform, original_url, original_screenshot_url, original_text, post_date,
          report_filed_date, report_text, report_screenshot_url,
          platform_response, platform_response_text,
          platform_response_screenshot_url, platform_response_date,
          country_iso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, submitted_at`,
      [
        submitter_name.trim(), submitter_email.trim(),
        platform, original_url || null, original_screenshot_url || null,
        original_text || null, post_date || null,
        report_filed_date || null, report_text || null, report_screenshot_url || null,
        platform_response, platform_response_text || null,
        platform_response_screenshot_url || null, platform_response_date || null,
        country_iso || null,
      ],
    );
    res.status(201).json({ id: rows[0].id, submitted_at: rows[0].submitted_at });
  } catch (err) {
    return sendMirrorError(res, err, 'insert failed');
  }
});

export default router;
