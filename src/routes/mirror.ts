import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// Ensure table exists (idempotent bootstrap — mirrors testimonies pattern)
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_mirror_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      submitter_name  TEXT NOT NULL,
      submitter_email TEXT NOT NULL,
      platform               TEXT NOT NULL
        CHECK (platform IN ('facebook','x','tiktok','instagram','youtube','other')),
      original_url            TEXT,
      original_screenshot_url TEXT,
      original_text           TEXT,
      post_date               DATE,
      report_filed_date       DATE,
      report_text             TEXT,
      report_screenshot_url   TEXT,
      platform_response TEXT NOT NULL DEFAULT 'no_response'
        CHECK (platform_response IN ('removed','no_action','appealed','no_response','other')),
      platform_response_text            TEXT,
      platform_response_screenshot_url  TEXT,
      platform_response_date            DATE,
      country_iso CHAR(2),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mirror_platform ON social_mirror_reports(platform)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mirror_status   ON social_mirror_reports(status)`);
}

// ── GET /api/mirror/stats ────────────────────────────────────────────────────
// Counts of approved reports grouped by platform and response type.
router.get('/stats', async (_req: Request, res: Response) => {
  await ensureTable();
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
    console.error(err);
    res.status(500).json({ error: 'stats failed' });
  }
});

// ── GET /api/mirror ──────────────────────────────────────────────────────────
// List approved reports. Supports ?platform=x&limit=50&offset=0&country=XX
router.get('/', async (req: Request, res: Response) => {
  await ensureTable();
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
    console.error(err);
    res.status(500).json({ error: 'fetch failed' });
  }
});

// ── GET /api/mirror/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  await ensureTable();
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
    console.error(err);
    res.status(500).json({ error: 'fetch failed' });
  }
});

// ── POST /api/mirror ─────────────────────────────────────────────────────────
// Submit a new report. Starts as status='pending' awaiting admin approval.
router.post('/', async (req: Request, res: Response) => {
  await ensureTable();

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
    console.error(err);
    res.status(500).json({ error: 'insert failed' });
  }
});

export default router;
