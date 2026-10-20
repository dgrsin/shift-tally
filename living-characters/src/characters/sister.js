// Character Engine for the youngest daughter ("sister"). Everything she knows
// lives in her state; the world's omniscient truth never enters her prompt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { J } from '../db/db.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { MIN, fmtSeoul, fmtClock, elapsedMin } from '../engine/clock.js';
import { CHARACTER_DECISION_SCHEMA } from '../engine/schemas.js';
import { completeWithRetry } from '../llm/client.js';
import { enqueueMessages, conversationHistory, unreadInbound, markInboundRead } from '../telegram/outbox.js';

const log = logger('sister');
const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = JSON.parse(fs.readFileSync(path.join(here, '../../prompts/characters/sister.json'), 'utf8'));
const PROMPT_TEMPLATE = fs.readFileSync(path.join(here, '../../prompts/character_sister.md'), 'utf8');

export const CHARACTER_NAME = PROFILE.name; // 'sister'
export const DISPLAY_NAME = PROFILE.display_name;

export function initialCharacterState(now) {
  const s = PROFILE.initial_state;
  return {
    name: CHARACTER_NAME,
    display_name: DISPLAY_NAME,
    location: s.location,
    activity: s.activity,
    can_call: s.can_call,
    emotional_state: s.emotional_state,
    stress: s.stress,
    knowledge: s.knowledge.map((k) => ({ ...k, at: now })),
    memory: s.memory.map((text) => ({ text, at: now })),
    goals: [...s.goals],
    intentions: [...s.intentions],
    relationships: s.relationships,
    pending_perceptions: [],
    next_check_in_world: now + config.sim.idleDeliberationMinPre * MIN,
    last_contact_decision: null,
    deliberation_count: 0,
  };
}

export function loadCharacter(db, simId) {
  const row = db.get('SELECT * FROM characters WHERE sim_id=? AND name=?', simId, CHARACTER_NAME);
  return row ? { ...row, state: J.parse(row.state, null) } : null;
}
export function saveCharacter(db, simId, state, now) {
  db.run(
    `INSERT INTO characters (sim_id, name, state, last_deliberation_world, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sim_id, name) DO UPDATE SET state=excluded.state, last_deliberation_world=COALESCE(excluded.last_deliberation_world, characters.last_deliberation_world), updated_at=excluded.updated_at`,
    simId, CHARACTER_NAME, J.str(state), state.last_deliberation_world ?? null, Date.now(),
  );
}

let systemPromptCache = null;
export function systemPrompt() {
  if (!systemPromptCache) {
    systemPromptCache = PROMPT_TEMPLATE
      .replaceAll('{{display_name}}', PROFILE.display_name)
      .replaceAll('{{role}}', PROFILE.role)
      .replaceAll('{{profile}}', JSON.stringify({ age: PROFILE.age, ...PROFILE.profile }, null, 1));
  }
  return systemPromptCache;
}

/** Does she have a reason to think right now? */
export function deliberationDue(db, sim, state, now) {
  if (state.pending_perceptions.length) return 'perception';
  if (unreadInbound(db, sim.id).length) return 'user_message';
  if (state.next_check_in_world != null && now >= state.next_check_in_world) return 'check_in';
  return null;
}

/**
 * Build what she sees. Strict knowledge isolation: only her own state, her
 * perceptions, and the conversation. No world truth, no scheduled events.
 */
export function buildCharacterInput(db, sim, state, now, { trigger, worldSister }) {
  const convo = conversationHistory(db, sim.id, 40);
  const inbound = unreadInbound(db, sim.id);
  const lastOut = [...convo].reverse().find((m) => m.direction === 'out');
  const lastIn = [...convo].reverse().find((m) => m.direction === 'in');
  const L = [];
  L.push(`[지금] ${fmtSeoul(now)}`);
  L.push(`[왜 지금 생각하는가] ${trigger === 'perception' ? '방금 새로운 일을 겪었다' : trigger === 'user_message' ? '오빠에게서 문자가 왔다' : trigger === 'check_in' ? '한동안 별일이 없어 상황을 다시 돌아본다' : trigger}`);
  L.push('');
  L.push('[현재 상태]');
  L.push(`- 위치: ${state.location} / 하는 중: ${worldSister?.activity ?? state.activity}`);
  L.push(`- 지금 통화 가능: ${(worldSister?.can_call ?? state.can_call) ? '예' : '아니오 (문자만 가능)'}`);
  L.push(`- 감정: ${state.emotional_state} / 스트레스 ${state.stress}/100`);
  L.push(`- 목표: ${state.goals.join('; ') || '없음'}`);
  L.push(`- 하려던 것: ${state.intentions.join('; ') || '없음'}`);
  L.push('');
  L.push('[내가 아는 사실]');
  for (const k of state.knowledge.slice(-30)) L.push(`- (${fmtClock(k.at)}, ${k.source}) ${k.fact}`);
  L.push('');
  L.push('[기억]');
  for (const m of state.memory.slice(-15)) L.push(`- ${fmtClock(m.at)} ${m.text}`);
  L.push('');
  L.push('[방금 겪은 일 (새로움)]');
  if (state.pending_perceptions.length) for (const p of state.pending_perceptions) L.push(`- ${fmtClock(p.world_time)} ${p.text}`);
  else L.push('- 없음');
  L.push('');
  L.push('[오빠와의 문자 기록 (최근)]');
  if (convo.length) for (const m of convo) L.push(`- ${fmtClock(m.world_time)} ${m.direction === 'out' ? '나' : '오빠'}: ${m.text}${m.status === 'pending' ? ' (전송 중)' : ''}`);
  else L.push('- 오늘은 아직 문자 없음');
  if (inbound.length) L.push(`\n[아직 답하지 않은 오빠 문자] ${inbound.map((m) => `"${m.text}"`).join(' / ')}`);
  if (lastOut) L.push(`- 내가 마지막으로 보낸 지 ${elapsedMin(lastOut.world_time, now)}분 지남${lastIn && lastIn.world_time < lastOut.world_time ? ' (오빠 답 없음)' : ''}`);
  L.push('');
  L.push(`[최근 연락 판단] ${state.last_contact_decision ? JSON.stringify(state.last_contact_decision) : '없음'}`);
  L.push('');
  L.push('[지시] 지금 무엇을 느끼고, 무엇을 하고, 오빠에게 연락할지 결정하라. 연락할 이유가 없으면 messages를 비워라.');
  return L.join('\n');
}

/**
 * One deliberation: perceive -> feel -> decide -> (message | act | wait).
 * Returns { decision, actions, sentCount } or null on failure.
 */
export async function deliberate(db, sim, now, { trigger }) {
  const ch = loadCharacter(db, sim.id);
  const state = ch.state;
  const worldSister = sim.world_state.characters.sister;
  const input = buildCharacterInput(db, sim, state, now, { trigger, worldSister });
  const inbound = unreadInbound(db, sim.id);
  let out;
  try {
    out = await completeWithRetry({
      tag: 'character', system: systemPrompt(), schema: CHARACTER_DECISION_SCHEMA, effort: config.llm.effort,
      messages: [{ role: 'user', content: input }],
      context: { kind: 'character', trigger, state, inbound, now, sim },
    });
  } catch (e) {
    log.error(`deliberation failed (${trigger}): ${e.message}`);
    // Back off, but keep perceptions/inbound so she thinks about them next time.
    state.next_check_in_world = now + 5 * MIN;
    saveCharacter(db, sim.id, state, now);
    return null;
  }
  // Guard rails the engine enforces regardless of the model's answer.
  if (!out.contact_decision.should_contact) out.messages = [];
  if (!(worldSister?.can_call ?? state.can_call) && out.contact_decision.channel === 'call_wanted') out.contact_decision.channel = 'text';
  out.messages = out.messages.slice(0, 6);

  let deliberationId;
  let sentCount = 0;
  db.transaction(() => {
    const r = db.run(
      `INSERT INTO deliberations (sim_id, character, world_time, trigger, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sim.id, CHARACTER_NAME, now, trigger, input, J.str(out), Date.now(),
    );
    deliberationId = Number(r.lastInsertRowid);
    sentCount = enqueueMessages(db, sim.id, CHARACTER_NAME, deliberationId, out.messages, now);
    // Apply state changes
    state.emotional_state = out.emotional_state || state.emotional_state;
    state.stress = Number.isFinite(out.stress) ? out.stress : state.stress;
    for (const k of out.knowledge_updates || []) if (k.fact) state.knowledge.push({ fact: k.fact, source: k.source || '경험', at: now });
    for (const p of state.pending_perceptions) state.knowledge.push({ fact: p.text, source: '직접 경험', at: p.world_time });
    if (out.memory_entry) state.memory.push({ text: out.memory_entry, at: now });
    if (Array.isArray(out.goals) && out.goals.length) state.goals = out.goals;
    if (Array.isArray(out.intentions)) state.intentions = out.intentions;
    state.pending_perceptions = [];
    state.last_contact_decision = { at: fmtClock(now), ...out.contact_decision };
    state.last_deliberation_world = now;
    state.deliberation_count++;
    const bounds = sim.world_state.phase === 'pre_accident' ? [15, 90] : [3, 45];
    const next = Math.min(bounds[1], Math.max(bounds[0], Number(out.next_check_in_min) || bounds[1]));
    state.next_check_in_world = now + next * MIN;
    state.activity = worldSister?.activity ?? state.activity;
    state.location = worldSister?.location ?? state.location;
    state.can_call = worldSister?.can_call ?? state.can_call;
    // Keep lists bounded
    if (state.knowledge.length > 80) state.knowledge = state.knowledge.slice(-80);
    if (state.memory.length > 40) state.memory = state.memory.slice(-40);
    markInboundRead(db, inbound.map((m) => m.id));
    saveCharacter(db, sim.id, state, now);
  });
  log.info(`deliberated (${trigger}) #${deliberationId}: contact=${out.contact_decision.should_contact} [${out.contact_decision.channel}/${out.contact_decision.urgency}] msgs=${sentCount} actions=${out.actions.length} stress=${state.stress}`, out.inner_monologue.slice(0, 160));
  return { deliberationId, decision: out, actions: out.actions || [], sentCount };
}

export function characterReport(db, simId) {
  const ch = loadCharacter(db, simId);
  if (!ch) return null;
  const last = db.get('SELECT * FROM deliberations WHERE sim_id=? AND character=? ORDER BY id DESC LIMIT 1', simId, CHARACTER_NAME);
  return { state: ch.state, last_deliberation: last ? { trigger: last.trigger, world_time: fmtSeoul(last.world_time), output: J.parse(last.output) } : null };
}
