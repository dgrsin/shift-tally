import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, Simulation, MockTelegram, config, world, sister, clock, makeSim, reply } from './helpers.js';

const MIN = clock.MIN;

test('1. the sister does not anticipate the accident before it happens', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(119);
  const s = db.get('SELECT * FROM simulations WHERE id=?', db.kvGet('active_sim'));
  assert.equal(JSON.parse(s.world_state).phase, 'pre_accident');
  // every prompt input she has seen so far must be free of accident knowledge
  const dels = db.all('SELECT input FROM deliberations');
  assert.ok(dels.length > 0, 'she deliberated at least once');
  for (const d of dels) {
    assert.doesNotMatch(d.input, /넘어지|낙상|사고|구급|응급|골절|병원/, 'pre-accident input leaks the future');
    assert.doesNotMatch(d.input, /truth|diagnosis|injury/i, 'world truth leaked into character input');
  }
  const ch = sister.loadCharacter(db, s.id);
  for (const k of ch.state.knowledge) assert.doesNotMatch(k.fact, /넘어지|사고|병원/);
  for (const m of tg.sent) assert.doesNotMatch(m.text, /넘어지|사고|병원/);
});

test('2. the accident is recorded at exactly start + 120 min even when processing is late', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  const s = db.get('SELECT * FROM simulations WHERE id=?', db.kvGet('active_sim'));
  const ev = db.get('SELECT * FROM events WHERE sim_id=? AND key=?', s.id, world.FIXED_ACCIDENT_KEY);
  assert.equal(ev.status, 'scheduled');
  assert.equal(ev.scheduled_world, s.started_at_real + config.sim.fixedEventOffsetMin * MIN);
  // Jump far past it in one go (simulates a sleeping/late process)
  await sim.fastForward(200);
  const after = db.get('SELECT * FROM events WHERE sim_id=? AND key=?', s.id, world.FIXED_ACCIDENT_KEY);
  assert.equal(after.status, 'completed');
  assert.equal(after.occurred_world, s.started_at_real + 120 * MIN, 'occurrence time is the scheduled time, not the processing time');
  assert.ok(after.fired_real >= s.started_at_real);
  // the fixed event can never be cancelled by the world engine
  world.applyWorldAdvance(db, world.loadSim(db, s.id), after.occurred_world + MIN, {
    phase: 'accident', truth_updates: { injury: '', diagnosis: '', mother_condition: '', notes: [] },
    character_updates: { sister: { location: 'x', activity: 'y', can_call: true }, mother: { location: 'x', status: 'y' } },
    new_events: [], cancel_event_keys: [world.FIXED_ACCIDENT_KEY], unresolved_situations: [],
  });
  assert.equal(db.get('SELECT status FROM events WHERE id=?', after.id).status, 'completed');
});

test('3. the sister contacts the user autonomously after the accident, not before it is her decision', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(121);
  const texts = tg.sent.map((m) => m.text);
  assert.ok(texts.some((t) => /통화 가능/.test(t)), `expected a contact after the accident, got ${JSON.stringify(texts)}`);
  const status = sim.status();
  assert.equal(status.accident.status, 'completed');
  // her decision is logged with a reason and a channel
  const last = db.get('SELECT output FROM deliberations ORDER BY id DESC LIMIT 1');
  const out = JSON.parse(last.output);
  assert.equal(out.contact_decision.should_contact, true);
  assert.ok(['text', 'call_wanted'].includes(out.contact_decision.channel));
});

test('4. the user reply changes what the sister knows and says', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(121);
  const before = tg.sent.length;
  await reply(sim, '내가 지금 갈게', 1);
  assert.ok(tg.sent.length > before, 'she replied');
  const ch = sister.loadCharacter(db, db.kvGet('active_sim'));
  assert.ok(ch.state.knowledge.some((k) => /오빠가 병원으로 오겠다고/.test(k.fact)), 'knowledge updated from the reply');
  assert.ok(!ch.state.knowledge.some((k) => /도착했다/.test(k.fact)), 'arrival is not assumed');
  // a different reply leads to a different answer
  const db2 = openDb(':memory:'); const tg2 = new MockTelegram(); const sim2 = makeSim(db2, tg2);
  await sim2.start(); await sim2.fastForward(121);
  await reply(sim2, '어느 병원이야?', 1);
  assert.ok(tg2.sent.some((m) => m.text === '중앙병원'));
  assert.ok(!tg.sent.some((m) => m.text === '중앙병원'));
  // inbound is read exactly once
  assert.equal(db.all(`SELECT * FROM messages WHERE direction='in' AND status='received'`).length, 0);
});

test('5. the world keeps moving for 3+ hours without any user reply', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(120 + 185);
  const st = sim.status();
  assert.ok(['results', 'aftermath', 'settled'].includes(st.phase), `phase advanced to ${st.phase}`);
  const keys = sim.events().filter((e) => e.status === 'completed').map((e) => e.key);
  for (const k of ['fixed:accident', 'ambulance_arrives', 'er_arrival', 'xray_results']) assert.ok(keys.includes(k), `${k} happened`);
  assert.equal(db.all(`SELECT * FROM messages WHERE direction='in'`).length, 0);
  // events are causally linked and ordered in time
  const evs = world.listEvents(db, st.id, { status: 'completed' });
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].occurred_world >= evs[i - 1].occurred_world);
  assert.ok(evs.filter((e) => e.caused_by != null).length >= 3, 'generated events record their cause');
});

test('6. outbound delivery: retries on failure, never duplicates, keeps order', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram({ failFirst: 2 }); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(121);
  // first send attempts failed -> pending with backoff
  let pending = db.all(`SELECT * FROM messages WHERE direction='out' AND status='pending'`);
  assert.ok(pending.length >= 1);
  assert.ok(pending[0].attempts >= 1);
  db.run(`UPDATE messages SET next_attempt_real=0 WHERE status='pending'`);
  await sim.flush();
  pending = db.all(`SELECT * FROM messages WHERE direction='out' AND status='pending'`);
  assert.equal(pending.length, 0);
  await sim.flush(); await sim.flush();
  const sentRows = db.all(`SELECT * FROM messages WHERE direction='out' AND status='sent'`);
  assert.equal(tg.sent.length, sentRows.length, 'each stored message was delivered exactly once');
  assert.deepEqual(tg.sent.map((m) => m.text), sentRows.map((m) => m.text));
  // idempotency: re-enqueueing the same deliberation output is a no-op
  const d = db.get('SELECT id, output, world_time FROM deliberations ORDER BY id DESC LIMIT 1');
  const { enqueueMessages } = await import('../src/telegram/outbox.js');
  const n = enqueueMessages(db, db.kvGet('active_sim'), 'sister', d.id, JSON.parse(d.output).messages, d.world_time);
  assert.equal(n, 0);
});

test('7. restart restores state: same world time, no duplicate events or messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  const file = path.join(dir, 'x.db');
  let db = openDb(file); let tg = new MockTelegram(); let sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(125);
  const beforeStatus = sim.status();
  const beforeEvents = db.all('SELECT id, key, status FROM events ORDER BY id');
  const beforeMsgs = db.all('SELECT id, text, status FROM messages ORDER BY id');
  db.close();
  // "process restart"
  db = openDb(file); tg = new MockTelegram(); sim = makeSim(db, tg);
  const after = sim.status();
  assert.equal(after.id, beforeStatus.id);
  assert.equal(after.phase, beforeStatus.phase);
  assert.ok(Math.abs(after.elapsed_min - beforeStatus.elapsed_min) <= 1);
  await sim.tick(); await sim.tick();
  assert.deepEqual(db.all('SELECT id, key, status FROM events ORDER BY id').filter((e) => e.status === 'completed'), beforeEvents.filter((e) => e.status === 'completed'));
  assert.equal(tg.sent.length, 0, 'already-sent messages are not re-sent after restart');
  assert.deepEqual(db.all('SELECT id, text, status FROM messages ORDER BY id'), beforeMsgs);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('8. pause freezes world time; resume continues without skipping; reset clears', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(30);
  const p = await sim.pause();
  assert.equal(p.status, 'paused');
  const frozen = world.loadActiveSim(db);
  const t1 = clock.worldNow(frozen, Date.now() + 60 * MIN);
  assert.equal(t1, clock.worldNow(frozen, Date.now()), 'world time does not move while paused');
  const r = await sim.resume();
  assert.equal(r.status, 'running');
  const s = world.loadActiveSim(db);
  assert.ok(Math.abs(clock.worldNow(s) - t1) < 2000);
  await sim.tick();
  assert.equal(db.get('SELECT status FROM events WHERE key=?', world.FIXED_ACCIDENT_KEY).status, 'scheduled');
  await sim.reset();
  assert.equal(sim.status().active, false);
  assert.equal(db.get('SELECT status FROM simulations WHERE id=?', s.id).status, 'reset');
  assert.equal(db.all(`SELECT * FROM events WHERE sim_id=? AND status='scheduled'`, s.id).length, 0);
});

test('9. knowledge isolation: hidden diagnosis never reaches the character before the results event', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg);
  await sim.start();
  await sim.fastForward(121 + 60); // accident + ER, before x-ray results (+95)
  const s = world.loadActiveSim(db);
  assert.ok(s.world_state.truth.injury.length > 0, 'world knows the truth');
  assert.equal(db.get('SELECT status FROM events WHERE sim_id=? AND key=?', s.id, 'xray_results').status, 'scheduled');
  for (const d of db.all('SELECT input FROM deliberations')) assert.doesNotMatch(d.input, /요골|골절/, 'diagnosis leaked before results');
  for (const m of tg.sent) assert.doesNotMatch(m.text, /요골|골절/);
  const ch = sister.loadCharacter(db, s.id);
  for (const k of ch.state.knowledge) assert.doesNotMatch(k.fact, /요골|골절/);
});

test('10. messages from a non-allowed chat are never answered (only ALLOWED_CHAT_ID)', async () => {
  const db = openDb(':memory:'); const tg = new MockTelegram(); const sim = makeSim(db, tg, '42');
  await sim.start();
  await sim.fastForward(121);
  const n = tg.sent.length;
  // The poller in main.js drops foreign chats before they reach the simulation;
  // here we assert the transport side: every message ever sent went to the allowed chat.
  await sim.flush();
  assert.ok(tg.sent.every((m) => m.chat_id === '42'));
  assert.equal(tg.sent.length, n);
});
