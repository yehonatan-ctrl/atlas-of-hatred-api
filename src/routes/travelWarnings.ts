import { Router } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/travel-warnings?country=XX
router.get('/', async (req, res) => {
  const country = String(req.query.country ?? '').trim().toUpperCase();

  if (!country) {
    // optional list mode
    try {
      const { rows } = await pool.query(
        `SELECT country_code, level, level_label, summary, issued_date, source_url, updated_at
         FROM travel_warnings
         ORDER BY level DESC, country_code ASC`
      );
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: 'failed' });
    }
  }

  if (!/^[A-Z]{2}$/.test(country)) {
    return res.status(400).json({ error: 'bad country' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT country_code, level, level_label, summary, issued_date, source_url, updated_at
       FROM travel_warnings
       WHERE country_code = $1
       LIMIT 1`,
      [country]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'failed' });
  }
});

export default router;
