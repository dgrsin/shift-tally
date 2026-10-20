// Long-polling loop for one bot. Offset is persisted so restarts never replay.
import { logger } from '../log.js';

export function startPoller({ api, db, name, onMessage, timeoutSec = 25, running = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const log = logger(`poll:${name}`);
  const offsetKey = `tg_offset:${name}`;
  let stopped = false;
  (async () => {
    try { await api.deleteWebhook(); } catch (e) { log.warn(`deleteWebhook: ${e.message}`); }
    while (!stopped && running()) {
      let updates;
      try {
        const offset = db.kvGet(offsetKey);
        updates = await api.getUpdates({ offset: offset ? Number(offset) : undefined, timeoutSec });
      } catch (e) {
        log.warn(`getUpdates failed: ${e.message}`);
        await sleep(e.status === 409 ? 10_000 : 5_000);
        continue;
      }
      for (const u of updates || []) {
        db.kvSet(offsetKey, u.update_id + 1);
        const dup = db.run(`INSERT OR IGNORE INTO inbound_updates (update_id, bot, received_at) VALUES (?, ?, ?)`, u.update_id, name, Date.now());
        if (dup.changes === 0) continue;
        const m = u.message;
        if (!m || typeof m.text !== 'string') continue;
        try { await onMessage({ chatId: String(m.chat.id), text: m.text, updateId: u.update_id, messageId: m.message_id, from: m.from }); }
        catch (e) { log.error(`handler failed: ${e.message}`); }
      }
      if (!updates?.length) await sleep(250);
    }
  })();
  return { stop() { stopped = true; } };
}
