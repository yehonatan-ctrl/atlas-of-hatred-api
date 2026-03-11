import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import incidentsRouter from './routes/incidents';
import countriesRouter from './routes/countries';
import testimoniesRouter from './routes/testimonies';
import leadersRouter from './routes/leaders';
import contactRouter from './routes/contact';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/incidents', incidentsRouter);
app.use('/api/countries', countriesRouter);
app.use('/api/testimonies', testimoniesRouter);
app.use('/api/leaders', leadersRouter);
app.use('/api/contact', contactRouter);

app.listen(PORT, () => {
  console.log(`Atlas of Hatred API running on port ${PORT}`);
});

export default app;
