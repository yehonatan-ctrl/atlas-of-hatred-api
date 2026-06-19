import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/countries
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.code, c.name_en, c.name_he, c.flag_emoji,
        CAST(c.score AS FLOAT) AS score,
        CAST(c.score_enforcement AS FLOAT) AS score_enforcement,
        CAST(c.score_street AS FLOAT) AS score_street,
        c.score_street_source, c.score_street_trend, c.score_street_context, c.score_street_source_url,
        c.police_reliable, c.embassy_info, c.key_companies,
        c.enforcement_law, c.enforcement_max, c.enforcement_trend, c.enforcement_source,
        c.enforcement_law_detail, c.enforcement_case, c.enforcement_sentence,
        c.enforcement_case_year, c.enforcement_case_assessment, c.enforcement_case_source,
        c.icj_joined_date, c.icj_role, c.icj_statement,
        cdp.public_display AS country_display_public_display,
        cdp.release_scope_bucket AS country_display_release_scope_bucket,
        cdp.decision_status AS country_display_decision_status,
        cdp.provisional AS country_display_provisional,
        cdp.owner_review_required AS country_display_owner_review_required,
        cdp.external_research_required AS country_display_external_research_required,
        cdp.tone_guidance AS country_display_tone_guidance,
        cdp.public_caveat AS country_display_public_caveat,
        cdp.privacy_rule AS country_display_privacy_rule,
        cdp.source_packet AS country_display_source_packet,
        cdp.updated_at AS country_display_updated_at
      FROM countries c
      LEFT JOIN country_display_policies cdp ON cdp.country_code = c.code
      ORDER BY c.score ASC NULLS LAST
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
      `SELECT c.*,
        cdp.public_display AS country_display_public_display,
        cdp.release_scope_bucket AS country_display_release_scope_bucket,
        cdp.decision_status AS country_display_decision_status,
        cdp.provisional AS country_display_provisional,
        cdp.owner_review_required AS country_display_owner_review_required,
        cdp.external_research_required AS country_display_external_research_required,
        cdp.tone_guidance AS country_display_tone_guidance,
        cdp.public_caveat AS country_display_public_caveat,
        cdp.privacy_rule AS country_display_privacy_rule,
        cdp.source_packet AS country_display_source_packet,
        cdp.updated_at AS country_display_updated_at
      FROM countries c
      LEFT JOIN country_display_policies cdp ON cdp.country_code = c.code
      WHERE c.code = $1`,
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
