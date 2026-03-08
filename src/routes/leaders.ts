import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/leaders?country=XX&sentiment=positive|negative
router.get('/', async (req: Request, res: Response) => {
  try {
    const { country, sentiment } = req.query;
    let query = `SELECT id, name, role AS title, city_or_region, country_code, quote, 
      TO_CHAR(quote_date, 'YYYY-MM-DD') AS quote_date,
      source_url, video_url, sentiment,
      CAST(COALESCE(severity_score, 0) AS INTEGER) AS severity_score
      FROM leaders WHERE is_published = TRUE`;
    const params: string[] = [];
    if (country) { params.push((country as string).toUpperCase()); query += ` AND country_code = $${params.length}`; }
    if (sentiment) { params.push(sentiment as string); query += ` AND sentiment = $${params.length}`; }
    // Sort: most extreme first (negative by severity asc, then positive by severity desc)
    query += ` ORDER BY ABS(COALESCE(severity_score, 0)) DESC, quote_date DESC`;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /leaders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
