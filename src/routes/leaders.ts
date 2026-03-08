import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/leaders?country=XX&sentiment=positive|negative
router.get('/', async (req: Request, res: Response) => {
  try {
    const { country, sentiment } = req.query;
    let query = `SELECT * FROM leaders WHERE is_published = TRUE`;
    const params: string[] = [];
    if (country) { params.push((country as string).toUpperCase()); query += ` AND country_code = $${params.length}`; }
    if (sentiment) { params.push(sentiment as string); query += ` AND sentiment = $${params.length}`; }
    query += ` ORDER BY quote_date DESC`;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /leaders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
