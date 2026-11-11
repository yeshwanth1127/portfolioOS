import cors from 'cors';
import express from 'express';
import { createRouter } from './routes.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'portfolio-os-api' }));
app.use(createRouter());

const port = Number(process.env.PORT ?? 4001);
app.listen(port, () => {
  console.log(`PortfolioOS API listening on :${port}`);
});
