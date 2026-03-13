import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/countries
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT code, name_en, name_he, flag_emoji,
        CAST(score AS FLOAT) AS score,
        CAST(score_enforcement AS FLOAT) AS score_enforcement,
        CAST(score_street AS FLOAT) AS score_street,
        score_street_source, score_street_trend, score_street_context, score_street_source_url,
        police_reliable, embassy_info, key_companies,
        enforcement_law, enforcement_max, enforcement_trend, enforcement_source,
        enforcement_law_detail, enforcement_case, enforcement_sentence,
        enforcement_case_year, enforcement_case_assessment, enforcement_case_source,
        icj_joined_date, icj_role, icj_statement
      FROM countries
      ORDER BY score ASC NULLS LAST
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
      [(req.params.code as string).toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /countries/:code error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
