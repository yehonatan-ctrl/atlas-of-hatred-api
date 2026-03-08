import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/incidents
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, lat, lng, city, country_code, type, title, date_occurred, severity, is_holocaust, is_verified
      FROM incidents
      WHERE is_published = TRUE
      ORDER BY date_occurred DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /incidents error:', err);
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
  const { lat, lng, city, country_code, type, title, description, date_occurred, severity } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO incidents (lat, lng, city, country_code, type, title, description, date_occurred, severity, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [lat, lng, city, country_code, type, title, description, date_occurred, severity]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('POST /incidents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
