import { createApp } from './app.js';
import { startWorker } from './jobs/queue.js';
import { syncQlixLinks } from './modules/qlix/provision.js';

const port = Number(process.env.PORT ?? 4001);
if (process.env.NODE_ENV !== 'test') {
  startWorker();
  // Catch up on Qlix webhooks Orbit missed (plugin turned on or off while the API was down).
  const syncMs = Number(process.env.QLIX_LINK_SYNC_MS ?? 180_000);
  const sync = () =>
    syncQlixLinks()
      .then((out) => {
        if (out?.results?.some((r) => r.linked || r.paused || r.error)) console.log('[qlix] link sync', JSON.stringify(out));
      })
      .catch((e) => console.warn('[qlix] link sync failed:', e.message));
  setTimeout(sync, 5_000).unref();
  setInterval(sync, syncMs).unref();
}
createApp().listen(port, () => {
  console.log(`PortfolioOS API listening on :${port}`);
});
