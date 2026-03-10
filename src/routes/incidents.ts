import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/incidents?country=XX&limit=N&type=X&severity=N
router.get('/', async (req: Request, res: Response) => {
  try {
    const { country, limit, type, severity, source_org } = req.query;
    const params: (string | number)[] = [];
    let where = 'WHERE is_published = TRUE';

    if (country) {
      params.push((country as string).toUpperCase());
      where += ` AND country_code = $${params.length}`;
    }
    if (type) {
      params.push(type as string);
      where += ` AND type = $${params.length}`;
    }
    if (severity) {
      params.push(parseInt(severity as string));
      where += ` AND severity >= $${params.length}`;
    }
    if (source_org) {
      params.push(source_org as string);
      where += ` AND source_org = $${params.length}`;
    }

    const limitVal = Math.min(parseInt((limit as string) ?? '10000'), 10000);

    const { rows } = await pool.query(`
      SELECT id,
        CAST(lat AS FLOAT) AS lat,
        CAST(lng AS FLOAT) AS lng,
        city, country_code, type, title,
        TO_CHAR(date_occurred, 'YYYY-MM-DD') AS date_occurred,
        severity, source_url, source_org, is_holocaust, is_verified, screenshot_url
      FROM incidents
      ${where}
      ORDER BY date_occurred DESC
      LIMIT ${limitVal}
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /incidents error:', err);
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
