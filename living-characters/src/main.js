// Process entry: DB, Telegram pollers, scheduler loop, admin API.
import { config, validateRuntimeConfig } from './config.js';
import { logger } from './log.js';
import { openDb } from './db/db.js';
import { Simulation } from './engine/simulation.js';
import { TelegramApi, MockTelegram } from './telegram/api.js';
import { startPoller } from './telegram/poller.js';
import { makeCommands } from './admin/commands.js';
import { startAdminServer } from './admin/http.js';
import { startAdminBot } from './admin/bot.js';
import { loadActiveSim } from './engine/world.js';
import { worldNow, fmtSeoul, MIN } from './engine/clock.js';

const log = logger('main');

async function main() {
  process.env.TZ = config.tz;
  for (const p of validateRuntimeConfig()) log.warn(`config: ${p}`);
  const db = openDb(config.dbPath);
  log.info(`db ${config.dbPath}`);

  // Character bot transport
  let transport = null;
  if (config.telegram.transport === 'mock') transport = new MockTelegram();
  else if (config.telegram.botToken) transport = new TelegramApi(config.telegram.botToken);
  if (transport) {
    try { const me = await transport.getMe(); log.info(`character bot: @${me.username} (${me.first_name})`); }
    catch (e) { log.error(`character bot getMe failed: ${e.message}`); }
  }

  const sim = new Simulation(db, { transport, chatId: config.telegram.allowedChatId || null });
  const commands = makeCommands(sim);

  // Resume report
  const active = loadActiveSim(db);
  if (active) log.info(`resuming ${active.id} [${active.status}] world=${fmtSeoul(worldNow(active))} phase=${active.world_state.phase}`);
  else log.info('no active simulation — use admin `start`');

  // Inbound from the user (character bot). Only ALLOWED_CHAT_ID is ever answered.
  if (transport && config.telegram.transport !== 'mock') {
    startPoller({
      api: transport, db, name: 'character', timeoutSec: config.telegram.pollTimeoutSec,
      async onMessage({ chatId, text, updateId, messageId, from }) {
        if (chatId !== config.telegram.allowedChatId) {
          log.warn(`message from non-allowed chat ${chatId} (${from?.username || from?.first_name || '?'}) ignored`);
          return;
        }
        sim.onUserMessage({ text, updateId, messageId });
      },
    });
  }

  // Admin bot (optional)
  if (config.telegram.adminBotToken) {
    const adminApi = new TelegramApi(config.telegram.adminBotToken);
    startAdminBot({ api: adminApi, db, commands });
    log.info(`admin bot enabled for chats: ${config.telegram.adminChatIds.join(', ') || '(none! set ADMIN_CHAT_IDS)'}`);
  }

  // Admin HTTP
  startAdminServer(commands);

  // Scheduler: check due events every few seconds; run a world tick on its cadence.
  let lastTickReal = 0;
  const loop = async () => {
    try {
      const s = loadActiveSim(db);
      if (s && s.status === 'running') {
        const now = worldNow(s);
        const due = db.get(`SELECT COUNT(*) AS n FROM events WHERE sim_id=? AND status='scheduled' AND scheduled_world <= ?`, s.id, now)?.n ?? 0;
        const tickDue = Date.now() - lastTickReal >= config.sim.tickIntervalSec * 1000;
        if (due > 0 || tickDue) { lastTickReal = Date.now(); await sim.tick(); }
        else await sim.flush(s.id); // retry any pending sends between ticks
      }
    } catch (e) { log.error(`loop error: ${e.stack || e.message}`); }
    setTimeout(loop, config.sim.schedulerPollSec * 1000);
  };
  loop();

  const shutdown = () => { log.info('shutting down'); try { db.close(); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.error(`fatal: ${e.stack || e.message}`); process.exit(1); });
