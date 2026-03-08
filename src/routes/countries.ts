import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/countries
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT code, name_en, name_he, score, police_reliable, embassy_phone
      FROM countries
      ORDER BY score ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /countries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/countries/:code
router.get('/:code', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM countries WHERE code = $1`,
      [req.params.code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /countries/:code error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
