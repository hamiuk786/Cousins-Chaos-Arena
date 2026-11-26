import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { MAX_PARTICIPANTS, ROOM_ID, ROUND_DURATION_MS, TICK_RATE } from './shared/protocol.ts';
import { attachAuthoritativeArenaServer } from './server/wsServer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  const httpServer = http.createServer(app);
  const arena = attachAuthoritativeArenaServer(httpServer);

  app.get('/api/health', (_req, res) => {
    const snap = arena.engine.buildSnapshot(false);
    res.json({
      status: 'ok',
      roomId: ROOM_ID,
      roomStatus: snap.status,
      isPaused: snap.isPaused,
      balloons: snap.balloons.length,
      connectedClients: snap.connectedCount,
      maxParticipants: MAX_PARTICIPANTS,
      roundDurationSeconds: ROUND_DURATION_MS / 1000,
      tickRateHz: TICK_RATE,
      singleInstanceMode: true,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Cousins Chaos Arena authoritative server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = async () => {
    arena.engine.saveCheckpointNow();
    await arena.close();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start Cousins Chaos Arena server:', err);
  process.exit(1);
});
