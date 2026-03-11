import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// POST /api/contact
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, email, incident_ref, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'name, email, message required' });
    }
    await pool.query(
      `INSERT INTO contact_requests (name, email, incident_ref, message, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [name, email, incident_ref || null, message]
    );
    res.json({ ok: true });
  } catch (err: any) {
    // Table might not exist yet — create it
    if (err.code === '42P01') {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS contact_requests (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          incident_ref TEXT,
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          resolved BOOLEAN DEFAULT FALSE
        )
      `);
      const { name, email, incident_ref, message } = req.body;
      await pool.query(
        `INSERT INTO contact_requests (name, email, incident_ref, message) VALUES ($1,$2,$3,$4)`,
        [name, email, incident_ref || null, message]
      );
      return res.json({ ok: true });
    }
    console.error('POST /contact error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
