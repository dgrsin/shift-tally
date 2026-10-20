// World Engine: omniscient state, fixed + generated events, causality, time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { J } from '../db/db.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { MIN, worldNow, fmtSeoul, fmtClock, elapsedMin } from './clock.js';
import { WORLD_ADVANCE_SCHEMA } from './schemas.js';
import { completeWithRetry } from '../llm/client.js';
import { loadCharacter, saveCharacter, initialCharacterState, CHARACTER_NAME } from '../characters/sister.js';

const log = logger('world');
const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(here, '../../prompts/world_engine.md');

export const FIXED_ACCIDENT_KEY = 'fixed:accident';
export const SCENARIO = 'family_emergency';

export function initialWorldState() {
  return {
    scenario: SCENARIO,
    phase: 'pre_accident',
    places: {
      sister_home: '지은의 집 (3층 빌라 2층, 현관 앞 외부 계단)',
      hospital: '중앙병원',
      mother_home: '엄마 집',
    },
    characters: {
      sister: { location: 'sister_home', activity: '엄마와 저녁 준비 중', can_call: true },
      mother: { location: 'sister_home', status: '건강함. 딸과 저녁 준비를 돕는 중' },
      user: { note: '오빠. 위치와 행동은 본인이 직접 말한 것만 기록한다 (미확인)' },
    },
    truth: { injury: '', diagnosis: '', mother_condition: '건강함', notes: [] },
    unresolved_situations: [],
    pending_character_actions: [],
  };
}

// ── simulation CRUD ────────────────────────────────────────────────────────
export function loadSim(db, simId) {
  const row = db.get('SELECT * FROM simulations WHERE id = ?', simId);
  if (!row) return null;
  return { ...row, world_state: J.parse(row.world_state, initialWorldState()) };
}
export function loadActiveSim(db) {
  const id = db.kvGet('active_sim');
  return id ? loadSim(db, id) : null;
}
export function saveSim(db, sim) {
  db.run(
    `UPDATE simulations SET status=?, time_offset_ms=?, paused_at_real=?, last_tick_world=?, last_world_advance_world=?, world_state=?, updated_at=? WHERE id=?`,
    sim.status, sim.time_offset_ms, sim.paused_at_real ?? null, sim.last_tick_world ?? null, sim.last_world_advance_world ?? null,
    J.str(sim.world_state), Date.now(), sim.id,
  );
}

/** Start a new simulation: world state, the fixed accident event, the character. DB only, no LLM. */
export function createSimulation(db, { realNow = Date.now() } = {}) {
  const id = `sim_${new Date(realNow).toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
  const accidentAt = realNow + config.sim.fixedEventOffsetMin * MIN;
  db.transaction(() => {
    const prev = db.kvGet('active_sim');
    if (prev) db.run(`UPDATE simulations SET status='ended', updated_at=? WHERE id=? AND status IN ('running','paused')`, realNow, prev);
    db.run(
      `INSERT INTO simulations (id, status, scenario, started_at_real, time_offset_ms, paused_at_real, last_tick_world, last_world_advance_world, world_state, created_at, updated_at)
       VALUES (?, 'running', ?, ?, 0, NULL, NULL, NULL, ?, ?, ?)`,
      id, SCENARIO, realNow, J.str(initialWorldState()), realNow, realNow,
    );
    insertEvent(db, id, {
      key: FIXED_ACCIDENT_KEY, type: 'accident', fixed: 1, scheduled_world: accidentAt, caused_by: null, visible_to: ['sister'],
      payload: {
        description: '어머니가 지은의 집에서 나오다 현관 앞 외부 계단에서 발을 헛디뎌 넘어진다. (확정 사건)',
        perceptions: {
          sister: '엄마가 집에 가시려고 나가다가 현관 앞 외부 계단에서 발을 헛디뎌 넘어지셨다. 계단 아래 층계참에 쓰러져 계시고 많이 아파하신다. 혼자서는 못 일어나신다.',
        },
      },
      created_at: realNow,
    });
    db.run(
      `INSERT INTO events (sim_id, key, type, status, fixed, scheduled_world, occurred_world, fired_real, payload, caused_by, visible_to, created_at)
       VALUES (?, 'sim:start', 'simulation_started', 'completed', 1, ?, ?, ?, ?, NULL, '[]', ?)`,
      id, realNow, realNow, realNow,
      J.str({ description: `시뮬레이션 시작 ${fmtSeoul(realNow)}. 확정 사건은 ${config.sim.fixedEventOffsetMin}분 뒤 (${fmtSeoul(accidentAt)}).`, perceptions: {} }),
      realNow,
    );
    saveCharacter(db, id, initialCharacterState(realNow), realNow);
    db.kvSet('active_sim', id);
  });
  log.info(`simulation ${id} created; accident scheduled at ${fmtSeoul(accidentAt)}`);
  return loadSim(db, id);
}

export function resetSimulation(db) {
  const id = db.kvGet('active_sim');
  if (id) {
    db.run(`UPDATE simulations SET status='reset', updated_at=? WHERE id=?`, Date.now(), id);
    db.run(`UPDATE events SET status='cancelled' WHERE sim_id=? AND status='scheduled'`, id);
    db.run(`UPDATE messages SET status='failed', last_error='reset' WHERE sim_id=? AND status='pending'`, id);
    db.kvDel('active_sim');
  }
  return id;
}

// ── events ─────────────────────────────────────────────────────────────────
export function insertEvent(db, simId, ev) {
  // Idempotent: same (sim, key) is a no-op.
  const r = db.run(
    `INSERT OR IGNORE INTO events (sim_id, key, type, status, fixed, scheduled_world, occurred_world, fired_real, payload, caused_by, visible_to, created_at)
     VALUES (?, ?, ?, 'scheduled', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    simId, ev.key, ev.type, ev.fixed ?? 0, Math.round(ev.scheduled_world), J.str(ev.payload), ev.caused_by ?? null, J.str(ev.visible_to ?? []), ev.created_at ?? Date.now(),
  );
  return r.changes > 0;
}
const rowToEvent = (r) => ({ ...r, payload: J.parse(r.payload, {}), visible_to: J.parse(r.visible_to, []) });
export function listEvents(db, simId, { status, limit = 200 } = {}) {
  const rows = status
    ? db.all('SELECT * FROM events WHERE sim_id=? AND status=? ORDER BY scheduled_world, id LIMIT ?', simId, status, limit)
    : db.all('SELECT * FROM events WHERE sim_id=? ORDER BY scheduled_world, id LIMIT ?', simId, limit);
  return rows.map(rowToEvent);
}
export function recentCompletedEvents(db, simId, limit = 20) {
  return db.all('SELECT * FROM events WHERE sim_id=? AND status=? ORDER BY occurred_world DESC, id DESC LIMIT ?', simId, 'completed', limit).map(rowToEvent).reverse();
}

/**
 * Fire every scheduled event whose world time has come, in order. The recorded
 * occurrence time is the *scheduled* world time (not when the process got to it),
 * so infrastructure delay never moves the fixed accident. Returns fired events.
 */
export function fireDueEvents(db, sim, now) {
  const due = db.all(
    `SELECT * FROM events WHERE sim_id=? AND status='scheduled' AND scheduled_world <= ? ORDER BY scheduled_world, id`, sim.id, now,
  ).map(rowToEvent);
  const fired = [];
  for (const ev of due) {
    const r = db.run(
      `UPDATE events SET status='completed', occurred_world=scheduled_world, fired_real=? WHERE id=? AND status='scheduled'`, Date.now(), ev.id,
    );
    if (r.changes === 0) continue; // someone else fired it: idempotent
    ev.status = 'completed'; ev.occurred_world = ev.scheduled_world;
    fired.push(ev);
    log.info(`event fired: ${ev.key} (${ev.type}) @ ${fmtSeoul(ev.occurred_world)}`);
    if (ev.key === FIXED_ACCIDENT_KEY) {
      sim.world_state.phase = 'accident';
      sim.world_state.truth.mother_condition = '계단에서 넘어져 쓰러짐 (부상 정도 미정)';
      sim.world_state.characters.mother.status = '계단 아래 층계참에 쓰러져 있음';
      sim.world_state.characters.sister.activity = '엄마 곁에서 당황함';
    }
  }
  return fired;
}

/** Deliver perceptions of fired events to characters who can perceive them. */
export function deliverPerceptions(db, sim, fired, now) {
  const ch = loadCharacter(db, sim.id);
  let added = 0;
  for (const ev of fired) {
    if (!ev.visible_to.includes(CHARACTER_NAME)) continue;
    const text = ev.payload?.perceptions?.[CHARACTER_NAME];
    if (!text) continue;
    ch.state.pending_perceptions.push({ event_id: ev.id, key: ev.key, world_time: ev.occurred_world, text });
    added++;
  }
  if (added) saveCharacter(db, sim.id, ch.state, now);
  return added;
}

export function queueCharacterActions(sim, actions, now) {
  for (const a of actions) {
    sim.world_state.pending_character_actions.push({ character: CHARACTER_NAME, description: a.description, duration_min: a.duration_min, world_time: now });
  }
}

// ── world advance (LLM) ────────────────────────────────────────────────────
let systemPromptCache = null;
function systemPrompt() {
  if (!systemPromptCache) {
    systemPromptCache = fs.readFileSync(PROMPT_PATH, 'utf8').replaceAll('{{fixed_offset_min}}', String(config.sim.fixedEventOffsetMin));
  }
  return systemPromptCache;
}

export function shouldAdvancePeriodically(db, sim, now) {
  const ws = sim.world_state;
  if (ws.phase === 'pre_accident' || ws.phase === 'settled') return false;
  const last = sim.last_world_advance_world ?? 0;
  const next = db.get(`SELECT MIN(scheduled_world) AS t FROM events WHERE sim_id=? AND status='scheduled'`, sim.id)?.t;
  // If developments are already scheduled, the world is not stalled: advance rarely.
  const hasUpcoming = next != null && next - now <= 45 * MIN;
  const interval = (hasUpcoming ? Math.max(30, config.sim.worldAdvanceMinPost) : config.sim.worldAdvanceMinPost) * MIN;
  return now - last >= interval;
}

function buildWorldInput(db, sim, now, { trigger, fired }) {
  const ws = sim.world_state;
  const start = sim.started_at_real;
  const accident = db.get('SELECT scheduled_world, status FROM events WHERE sim_id=? AND key=?', sim.id, FIXED_ACCIDENT_KEY);
  const recent = recentCompletedEvents(db, sim.id, 20);
  const scheduled = listEvents(db, sim.id, { status: 'scheduled' });
  const convo = db.all('SELECT direction, text, world_time FROM messages WHERE sim_id=? AND status IN (\'sent\',\'received\',\'read\',\'pending\') ORDER BY world_time DESC, id DESC LIMIT 12', sim.id).reverse();
  const lines = [];
  lines.push(`[세계 시각] ${fmtSeoul(now)} (시작 후 ${elapsedMin(start, now)}분) / 현재 단계: ${ws.phase}`);
  lines.push(`[확정 사건] 어머니 계단 낙상: ${fmtSeoul(accident.scheduled_world)} — ${accident.status === 'completed' ? '이미 발생함' : `${elapsedMin(now, accident.scheduled_world)}분 뒤 발생 예정 (그 전까지 어머니와 지은은 지은의 집에 있어야 함)`}`);
  lines.push(`[트리거] ${trigger}`);
  lines.push('');
  lines.push('[세계 상태 (전지적)]');
  lines.push(JSON.stringify({ places: ws.places, characters: ws.characters, truth: ws.truth, unresolved_situations: ws.unresolved_situations }, null, 1));
  lines.push('');
  lines.push('[방금 발생한 사건]');
  if (fired?.length) for (const e of fired) lines.push(`- ${fmtClock(e.occurred_world)} ${e.key} (${e.type}): ${e.payload.description}`);
  else lines.push('- 없음');
  lines.push('');
  lines.push('[최근 완료된 사건]');
  for (const e of recent) lines.push(`- ${fmtClock(e.occurred_world)} ${e.key} (${e.type}): ${e.payload.description}`);
  lines.push('');
  lines.push('[이미 예정된 사건 (같은 key 재사용 금지)]');
  if (scheduled.length) for (const e of scheduled) lines.push(`- +${elapsedMin(now, e.scheduled_world)}분 ${e.key} (${e.type}): ${e.payload.description}`);
  else lines.push('- 없음');
  lines.push('');
  lines.push('[인물의 행동 — 아직 세계가 결과를 돌려주지 않음]');
  if (ws.pending_character_actions.length) for (const a of ws.pending_character_actions) lines.push(`- ${fmtClock(a.world_time)} 지은: ${a.description} (약 ${a.duration_min}분)`);
  else lines.push('- 없음');
  lines.push('');
  lines.push('[최근 문자 지은↔오빠 — 오빠의 말은 본인 진술일 뿐, 세계에서 확인된 사실이 아님]');
  if (convo.length) for (const m of convo) lines.push(`- ${fmtClock(m.world_time)} ${m.direction === 'out' ? '지은' : '오빠'}: ${m.text}`);
  else lines.push('- 없음');
  lines.push('');
  lines.push('[지시] 위 상황에서 세계를 앞으로 진행시켜라. 행동의 결과를 사건으로 돌려주고, 필요한 후속 사건을 예정하라. 아무것도 바꿀 필요가 없으면 new_events를 비워라.');
  if (ws.phase === 'pre_accident') lines.push('사고 전 구간이다: 소소한 일상 사건 0~2개만, 확정 사건 시각 이전에만 예정하라. 사고를 암시하는 사건은 만들지 마라.');
  return lines.join('\n');
}

/** Ask the World Engine LLM to advance the world. Applies the result to DB. */
export async function worldAdvance(db, sim, now, { trigger, fired = [] }) {
  const input = buildWorldInput(db, sim, now, { trigger, fired });
  let out;
  try {
    out = await completeWithRetry({
      tag: 'world', system: systemPrompt(), schema: WORLD_ADVANCE_SCHEMA, effort: config.llm.effort,
      messages: [{ role: 'user', content: input }],
      context: { kind: 'world', trigger, fired, world_state: sim.world_state, now, sim },
    });
  } catch (e) {
    log.error(`world advance failed (${trigger}): ${e.message}`);
    sim.last_world_advance_world = now; // don't hammer the API; next periodic window retries
    saveSim(db, sim);
    return { ok: false, error: e.message, inserted: [] };
  }
  const inserted = applyWorldAdvance(db, sim, now, out, fired);
  log.info(`world advanced (${trigger}): phase=${sim.world_state.phase}, +${inserted.length} events`, out.narration);
  return { ok: true, inserted, narration: out.narration };
}

export function applyWorldAdvance(db, sim, now, out, fired = []) {
  const ws = sim.world_state;
  const inserted = [];
  db.transaction(() => {
    if (out.phase) ws.phase = out.phase;
    const t = out.truth_updates || {};
    if (t.injury) ws.truth.injury = t.injury;
    if (t.diagnosis) ws.truth.diagnosis = t.diagnosis;
    if (t.mother_condition) ws.truth.mother_condition = t.mother_condition;
    if (Array.isArray(t.notes)) for (const n of t.notes) if (n && !ws.truth.notes.includes(n)) ws.truth.notes.push(n);
    if (out.character_updates?.sister) ws.characters.sister = { ...ws.characters.sister, ...out.character_updates.sister };
    if (out.character_updates?.mother) ws.characters.mother = { ...ws.characters.mother, ...out.character_updates.mother };
    if (Array.isArray(out.unresolved_situations)) ws.unresolved_situations = out.unresolved_situations;
    for (const key of out.cancel_event_keys || []) {
      if (key === FIXED_ACCIDENT_KEY) continue; // the fixed event cannot be cancelled
      db.run(`UPDATE events SET status='cancelled' WHERE sim_id=? AND key=? AND status='scheduled'`, sim.id, key);
    }
    // Causality: the event that triggered this advance, else the latest completed event.
    const causedBy = fired[0]?.id ?? db.get(`SELECT id FROM events WHERE sim_id=? AND status='completed' ORDER BY occurred_world DESC, id DESC LIMIT 1`, sim.id)?.id ?? null;
    for (const ev of out.new_events || []) {
      if (!ev.key || ev.key === FIXED_ACCIDENT_KEY) continue;
      const key = ev.key.toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').slice(0, 64);
      const offset = Math.max(0, Number(ev.offset_min) || 0);
      const scheduled_world = now + Math.round(offset * MIN);
      // Nothing may be scheduled before an un-fired fixed accident other than ambient pre-accident life.
      const visible_to = Array.isArray(ev.visible_to) ? ev.visible_to : [];
      const ok = insertEvent(db, sim.id, {
        key, type: ev.type || 'event', fixed: 0, scheduled_world, caused_by: causedBy, visible_to,
        payload: { description: ev.description, perceptions: ev.perception_sister ? { sister: ev.perception_sister } : {} },
        created_at: Date.now(),
      });
      if (ok) inserted.push({ key, scheduled_world, type: ev.type });
    }
    ws.pending_character_actions = [];
    sim.last_world_advance_world = now;
    saveSim(db, sim);
  });
  return inserted;
}

export function statusSummary(db, sim) {
  if (!sim) return { active: false };
  const now = worldNow(sim);
  const accident = db.get('SELECT scheduled_world, status FROM events WHERE sim_id=? AND key=?', sim.id, FIXED_ACCIDENT_KEY);
  const counts = db.get(`SELECT SUM(status='scheduled') AS scheduled, SUM(status='completed') AS completed FROM events WHERE sim_id=?`, sim.id);
  const msgs = db.get(`SELECT SUM(direction='out' AND status='sent') AS sent, SUM(direction='out' AND status='pending') AS pending, SUM(direction='in') AS received FROM messages WHERE sim_id=?`, sim.id);
  const ch = loadCharacter(db, sim.id);
  return {
    active: true,
    id: sim.id,
    status: sim.status,
    started_at: fmtSeoul(sim.started_at_real),
    world_time: fmtSeoul(now),
    elapsed_min: elapsedMin(sim.started_at_real, now),
    time_offset_min: Math.round(sim.time_offset_ms / MIN),
    phase: sim.world_state.phase,
    accident: { at: fmtSeoul(accident.scheduled_world), status: accident.status, in_min: accident.status === 'scheduled' ? elapsedMin(now, accident.scheduled_world) : null },
    events: counts,
    messages: msgs,
    last_tick: sim.last_tick_world ? fmtSeoul(sim.last_tick_world) : null,
    last_world_advance: sim.last_world_advance_world ? fmtSeoul(sim.last_world_advance_world) : null,
    characters: sim.world_state.characters,
    truth: sim.world_state.truth,
    unresolved_situations: sim.world_state.unresolved_situations,
    sister: ch ? { emotional_state: ch.state.emotional_state, stress: ch.state.stress, location: ch.state.location, activity: ch.state.activity, can_call: ch.state.can_call, next_check_in: ch.state.next_check_in_world ? fmtSeoul(ch.state.next_check_in_world) : null, pending_perceptions: ch.state.pending_perceptions.length } : null,
  };
}
