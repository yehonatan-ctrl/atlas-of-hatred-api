import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/incidents?country=XX&limit=N&type=X&severity=N
router.get('/', async (req: Request, res: Response) => {
  try {
    const { country, limit, type, severity, source_org } = req.query;
    const params: (string | number)[] = [];
    let where = 'WHERE i.is_published = TRUE';

    if (country) {
      params.push((country as string).toUpperCase());
      where += ` AND COALESCE(i.event_country_code, i.country_code) = $${params.length}`;
    }
    if (type) {
      params.push(type as string);
      where += ` AND i.type = $${params.length}`;
    }
    if (severity) {
      params.push(parseInt(severity as string));
      where += ` AND i.severity >= $${params.length}`;
    }
    if (source_org) {
      params.push(source_org as string);
      where += ` AND COALESCE(ps.source_org, i.source_org) = $${params.length}`;
    }

    const limitVal = Math.min(parseInt((limit as string) ?? '10000'), 10000);

    const { rows } = await pool.query(`
      SELECT i.id,
        CAST(i.lat AS FLOAT) AS lat,
        CAST(i.lng AS FLOAT) AS lng,
        i.city,
        i.country_code,
        COALESCE(i.event_country_code, i.country_code) AS event_country_code,
        COALESCE(i.canonical_city, i.city) AS canonical_city,
        i.type,
        i.title,
        TO_CHAR(i.date_occurred, 'YYYY-MM-DD') AS date_occurred,
        i.severity,
        i.source_url,
        i.source_org,
        ps.canonical_source_url,
        ps.source_type,
        ps.source_quality,
        ps.public_evidence_summary,
        TO_CHAR(ps.source_checked_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS source_checked_at,
        i.event_confidence,
        i.provenance_review_status,
        i.report_domain,
        i.is_holocaust,
        i.is_verified,
        i.screenshot_url
      FROM incidents i
      LEFT JOIN LATERAL (
        SELECT canonical_source_url,
          source_org,
          source_type,
          source_quality,
          public_evidence_summary,
          source_checked_at
        FROM incident_sources
        WHERE incident_id = i.id
        ORDER BY is_primary_source DESC, created_at ASC
        LIMIT 1
      ) ps ON TRUE
      ${where}
      ORDER BY i.date_occurred DESC
      LIMIT ${limitVal}
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /incidents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/incidents/trend?country=XX
// Returns monthly incident counts for a country (or global if no country)
router.get('/trend', async (req: Request, res: Response) => {
  try {
    const { country } = req.query;
    const params: string[] = [];
    let where = "WHERE is_published = TRUE AND date_occurred IS NOT NULL AND date_occurred >= '2020-01-01'";
    if (country) {
      params.push((country as string).toUpperCase());
      where += ` AND country_code = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(date_occurred, 'YYYY-MM') AS month,
        COUNT(*)::int AS count
      FROM incidents
      ${where}
      GROUP BY month
      ORDER BY month
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /incidents/trend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/incidents/sources — list available source orgs
router.get('/sources', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT source_org, COUNT(*) AS count
      FROM incidents
      WHERE is_published = TRUE AND source_org IS NOT NULL
      GROUP BY source_org
      ORDER BY COUNT(*) DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/incidents/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM incidents WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /incidents/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/incidents
router.post('/', async (req: Request, res: Response) => {
  const { lat, lng, city, country_code, type, title, description, date_occurred, severity, source_url } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO incidents (lat, lng, city, country_code, type, title, description, date_occurred, severity, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [lat, lng, city, country_code, type, title, description, date_occurred, severity, source_url]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('POST /incidents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
