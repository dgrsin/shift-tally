// Orchestrator: ties clock, world, character and messaging together.
// Everything that mutates the simulation runs under one async mutex.
import { config } from '../config.js';
import { logger } from '../log.js';
import { MIN, worldNow, pause as clockPause, resume as clockResume, fastForward as clockFF, fmtSeoul } from './clock.js';
import {
  loadActiveSim, saveSim, createSimulation, resetSimulation, fireDueEvents, deliverPerceptions,
  worldAdvance, shouldAdvancePeriodically, queueCharacterActions, listEvents, statusSummary,
} from './world.js';
import { loadCharacter, deliberate, deliberationDue, characterReport, CHARACTER_NAME } from '../characters/sister.js';
import { flushOutbox, recordInbound } from '../telegram/outbox.js';

const log = logger('sim');

export class Simulation {
  constructor(db, { transport = null, chatId = null, sleep } = {}) {
    this.db = db;
    this.transport = transport;
    this.chatId = chatId;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._lock = Promise.resolve();
    this._inboundTimer = null;
  }

  /** Serialize all mutations. */
  locked(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  // ── admin ────────────────────────────────────────────────────────────────
  start() { return this.locked(async () => {
    const sim = createSimulation(this.db);
    await this._advanceWorld(sim, worldNow(sim), { trigger: 'start' });
    return statusSummary(this.db, sim);
  }); }
  pause() { return this.locked(async () => {
    const sim = loadActiveSim(this.db); if (!sim) return { active: false };
    const next = clockPause(sim); saveSim(this.db, next); log.info('paused');
    return statusSummary(this.db, next);
  }); }
  resume() { return this.locked(async () => {
    const sim = loadActiveSim(this.db); if (!sim) return { active: false };
    const next = clockResume(sim); saveSim(this.db, next); log.info('resumed');
    return statusSummary(this.db, next);
  }); }
  reset() { return this.locked(async () => { const id = resetSimulation(this.db); log.info(`reset ${id ?? '(none)'}`); return { reset: id }; }); }
  status() { return statusSummary(this.db, loadActiveSim(this.db)); }
  events({ limit = 100 } = {}) {
    const sim = loadActiveSim(this.db); if (!sim) return [];
    return listEvents(this.db, sim.id, { limit }).map((e) => ({
      id: e.id, key: e.key, type: e.type, status: e.status, fixed: !!e.fixed,
      scheduled: fmtSeoul(e.scheduled_world), occurred: e.occurred_world ? fmtSeoul(e.occurred_world) : null,
      fired_real: e.fired_real ? fmtSeoul(e.fired_real) : null, caused_by: e.caused_by, visible_to: e.visible_to,
      description: e.payload.description, perception_sister: e.payload.perceptions?.sister ?? null,
    }));
  }
  character() { const sim = loadActiveSim(this.db); return sim ? characterReport(this.db, sim.id) : null; }
  conversation() {
    const sim = loadActiveSim(this.db); if (!sim) return [];
    return this.db.all(`SELECT id, direction, text, status, world_time, real_time, attempts, last_error FROM messages WHERE sim_id=? ORDER BY id`, sim.id)
      .map((m) => ({ ...m, world_time: fmtSeoul(m.world_time), real_time: fmtSeoul(m.real_time) }));
  }

  /**
   * Fast forward `minutes` of world time. Rather than jumping, the clock is
   * advanced to each due point (next event or check-in) in turn and a tick is
   * run there, so the story unfolds in the same order it would in real time.
   */
  fastForward(minutes) { return this.locked(async () => {
    if (!config.sim.allowFastForward) throw new Error('fast forward disabled (ALLOW_FAST_FORWARD=false)');
    let sim = loadActiveSim(this.db); if (!sim) return { active: false };
    if (sim.status !== 'running') throw new Error('simulation is not running');
    const target = worldNow(sim) + minutes * MIN;
    let steps = 0;
    while (steps++ < 200) {
      sim = loadActiveSim(this.db);
      const now = worldNow(sim);
      const nextEvent = this.db.get(`SELECT MIN(scheduled_world) AS t FROM events WHERE sim_id=? AND status='scheduled'`, sim.id)?.t;
      const ch = loadCharacter(this.db, sim.id);
      const candidates = [nextEvent, ch?.state.next_check_in_world, (sim.last_world_advance_world ?? now) + config.sim.worldAdvanceMinPost * MIN]
        .filter((t) => t != null && t > now && t <= target);
      if (!candidates.length) break;
      const jumpTo = Math.min(...candidates);
      saveSim(this.db, clockFF(sim, (jumpTo - now) / MIN));
      await this._tick();
    }
    sim = loadActiveSim(this.db);
    const remaining = target - worldNow(sim);
    if (remaining > 0) { saveSim(this.db, clockFF(sim, remaining / MIN)); await this._tick(); }
    log.info(`fast-forwarded ${minutes} min in ${steps} steps`);
    return statusSummary(this.db, loadActiveSim(this.db));
  }); }

  // ── runtime ──────────────────────────────────────────────────────────────
  tick() { return this.locked(() => this._tick()); }

  async _tick() {
    const sim = loadActiveSim(this.db);
    if (!sim || sim.status !== 'running') return { skipped: true };
    const now = worldNow(sim);
    // 1. fire due events (DB only; cannot be blocked by the LLM)
    const fired = fireDueEvents(this.db, sim, now);
    if (fired.length) { saveSim(this.db, sim); deliverPerceptions(this.db, sim, fired, now); }
    // 2. world engine: consequences & new developments
    if (fired.length) await this._advanceWorld(sim, now, { trigger: `events_fired:${fired.map((e) => e.key).join(',')}`, fired });
    else if (shouldAdvancePeriodically(this.db, sim, now)) await this._advanceWorld(sim, now, { trigger: 'periodic' });
    // 3. character: does she have a reason to think?
    await this._maybeDeliberate(sim, now);
    // 4. deliver
    await this.flush(sim.id);
    sim.last_tick_world = now;
    saveSim(this.db, sim);
    return { fired: fired.length };
  }

  /** World advance; immediate (offset 0) events fire in the same pass, up to 3 rounds. */
  async _advanceWorld(sim, now, opts) {
    let res = await worldAdvance(this.db, sim, now, opts);
    for (let round = 0; round < 3 && res.ok; round++) {
      const fired = fireDueEvents(this.db, sim, now);
      if (!fired.length) break;
      saveSim(this.db, sim); deliverPerceptions(this.db, sim, fired, now);
      res = await worldAdvance(this.db, sim, now, { trigger: `events_fired:${fired.map((e) => e.key).join(',')}`, fired });
    }
    return res;
  }

  async _maybeDeliberate(sim, now) {
    const ch = loadCharacter(this.db, sim.id);
    if (!ch) return;
    const why = deliberationDue(this.db, sim, ch.state, now);
    if (!why) return;
    const result = await deliberate(this.db, sim, now, { trigger: why });
    if (result?.actions?.length) {
      queueCharacterActions(sim, result.actions, now);
      saveSim(this.db, sim);
      await this._advanceWorld(sim, now, { trigger: 'character_actions' });
    }
  }

  flush(simId) {
    if (!this.transport || !this.chatId) return 0;
    return flushOutbox(this.db, this.transport, { chatId: this.chatId, simId, sleep: this.sleep });
  }

  // ── inbound ──────────────────────────────────────────────────────────────
  /** Store a user message now; deliberate after a short debounce so bursts are read together. */
  onUserMessage({ text, updateId, messageId }) {
    const sim = loadActiveSim(this.db);
    if (!sim) { log.warn('user message ignored: no active simulation'); return false; }
    const now = worldNow(sim);
    const isNew = recordInbound(this.db, sim.id, CHARACTER_NAME, { text, updateId, messageId, worldTime: now });
    if (!isNew) return false;
    log.info(`user: ${text}`);
    if (sim.status === 'running') this.scheduleInboundDeliberation();
    return true;
  }

  /** Debounced: (re)arms a timer; when it fires, the character reads everything unread. */
  scheduleInboundDeliberation(delayMs = config.sim.inboundDebounceMs) {
    clearTimeout(this._inboundTimer);
    this._pendingInbound = new Promise((resolve) => {
      this._inboundTimer = setTimeout(() => {
        this.locked(async () => {
          const s = loadActiveSim(this.db);
          if (!s || s.status !== 'running') return;
          await this._maybeDeliberate(s, worldNow(s));
          await this.flush(s.id);
        }).catch((e) => log.error(`inbound deliberation failed: ${e.message}`)).finally(resolve);
      }, delayMs);
    });
    return this._pendingInbound;
  }
}
