import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/testimonies/:incident_id
router.get('/:incident_id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, incident_id, body_text, is_self, status, created_at
       FROM testimonies
       WHERE incident_id = $1 AND status = 'approved'
       ORDER BY created_at DESC`,
      [req.params.incident_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /testimonies/:incident_id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/testimonies
router.post('/', async (req: Request, res: Response) => {
  const { incident_id, user_id, body_text, is_self } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO testimonies (incident_id, user_id, body_text, is_self, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [incident_id, user_id, body_text, is_self ?? false]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('POST /testimonies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
