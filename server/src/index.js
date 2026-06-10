import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { publicRouter } from './routes/public.js';
import { authRouter } from './routes/auth.js';
import { peeringsRouter } from './routes/peerings.js';
import { adminRouter } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

app.use('/api', publicRouter);
app.use('/api/auth', authRouter);
app.use('/api/peerings', peeringsRouter);
app.use('/api/admin', adminRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Serve the built frontend (single-process deployment).
const dist = path.resolve(__dirname, '../../frontend/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('dn42-peering API is running. Build the frontend (npm run build in frontend/) to serve the UI.'));
}

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(config.port, () => {
  console.log(`dn42-peering server on :${config.port}${config.demo ? ' (DEMO MODE)' : ''}`);
});
