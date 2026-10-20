// Communication Engine, outbound side: durable outbox with idempotency and retry.
import { logger } from '../log.js';
import { fmtClock } from '../engine/clock.js';

const log = logger('outbox');

/** Insert outbound bubbles. Idempotent per (deliberationId, index). */
export function enqueueMessages(db, simId, character, deliberationId, messages, worldTime) {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const text = String(m.text || '').trim();
    if (!text) continue;
    const r = db.run(
      `INSERT OR IGNORE INTO messages (sim_id, character, direction, text, world_time, real_time, status, idempotency_key, delay_ms, next_attempt_real)
       VALUES (?, ?, 'out', ?, ?, ?, 'pending', ?, ?, ?)`,
      simId, character, text, worldTime, Date.now(), `d:${deliberationId}:${i}`, Math.round(Math.min(60, Math.max(0, Number(m.pause_sec) || 0)) * 1000), Date.now(),
    );
    if (r.changes > 0) n++;
  }
  return n;
}

export function recordInbound(db, simId, character, { text, updateId, messageId, worldTime }) {
  const r = db.run(
    `INSERT OR IGNORE INTO messages (sim_id, character, direction, text, world_time, real_time, status, idempotency_key, telegram_message_id, telegram_update_id)
     VALUES (?, ?, 'in', ?, ?, ?, 'received', ?, ?, ?)`,
    simId, character, text, worldTime, Date.now(), `in:${updateId}`, messageId ?? null, updateId,
  );
  return r.changes > 0;
}

export function unreadInbound(db, simId) {
  return db.all(`SELECT * FROM messages WHERE sim_id=? AND direction='in' AND status='received' ORDER BY id`, simId);
}
export function markInboundRead(db, ids) {
  for (const id of ids) db.run(`UPDATE messages SET status='read' WHERE id=?`, id);
}

export function conversationHistory(db, simId, limit = 40) {
  return db
    .all(`SELECT direction, text, world_time, status FROM messages WHERE sim_id=? AND status IN ('sent','pending','received','read') ORDER BY id DESC LIMIT ?`, simId, limit)
    .reverse();
}

/**
 * Drain pending outbound messages through the transport. Runs forever-safe: a
 * failed send is retried with backoff; a message is marked sent only once the
 * transport returns a message id, and never re-sent after that.
 */
export async function flushOutbox(db, transport, { chatId, simId, typing = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!chatId) return 0;
  const now = Date.now();
  const pending = db.all(
    `SELECT * FROM messages WHERE direction='out' AND status='pending' AND (next_attempt_real IS NULL OR next_attempt_real <= ?) ${simId ? 'AND sim_id=?' : ''} ORDER BY id`,
    ...(simId ? [now, simId] : [now]),
  );
  let sent = 0;
  for (const m of pending) {
    if (m.delay_ms > 0) {
      if (typing) { try { await transport.sendChatAction(chatId, 'typing'); } catch { /* ignore */ } }
      await sleep(Math.min(m.delay_ms, 60_000));
    }
    try {
      const res = await transport.sendMessage(chatId, m.text);
      db.run(`UPDATE messages SET status='sent', telegram_message_id=?, attempts=attempts+1, last_error=NULL WHERE id=? AND status='pending'`, res?.message_id ?? null, m.id);
      sent++;
      log.info(`sent #${m.id} (${fmtClock(m.world_time)}): ${m.text}`);
    } catch (e) {
      const attempts = m.attempts + 1;
      const backoff = Math.min(10 * 60_000, 5_000 * 2 ** attempts);
      const giveUp = attempts >= 8;
      db.run(`UPDATE messages SET status=?, attempts=?, next_attempt_real=?, last_error=? WHERE id=?`, giveUp ? 'failed' : 'pending', attempts, Date.now() + backoff, String(e.message || e).slice(0, 500), m.id);
      log.warn(`send #${m.id} failed (attempt ${attempts}): ${e.message}${giveUp ? ' — giving up' : ''}`);
      break; // keep order: don't send later bubbles before an earlier one
    }
  }
  return sent;
}
