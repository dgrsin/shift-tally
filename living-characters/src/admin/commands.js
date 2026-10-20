// Admin command surface shared by the HTTP API, the admin bot and the CLI.
import { config } from '../config.js';

export function makeCommands(sim) {
  return {
    async start() { return sim.start(); },
    async pause() { return sim.pause(); },
    async resume() { return sim.resume(); },
    async reset() { return sim.reset(); },
    async status() { return sim.status(); },
    async events(args = {}) { return sim.events({ limit: Number(args.limit) || 100 }); },
    async character() { return sim.character(); },
    async conversation() { return sim.conversation(); },
    async tick() { return sim.tick(); },
    async ff(args = {}) {
      const minutes = Number(args.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new Error('minutes must be 1..1440');
      return sim.fastForward(minutes);
    },
    async config() {
      return {
        llm: { provider: config.llm.provider, model: config.llm.model, effort: config.llm.effort },
        sim: config.sim, tz: config.tz, chat_id_set: !!config.telegram.allowedChatId, admin_bot: !!config.telegram.adminBotToken,
      };
    },
  };
}

export const HELP = [
  'start — 새 시뮬레이션 시작 (기존 것은 종료)',
  'pause / resume — 일시 중지 / 재개 (세계 시간도 멈춤)',
  'reset — 현재 시뮬레이션 초기화',
  'status — 세계 상태 요약',
  'events [limit] — 사건 로그',
  'character — 막내딸 내부 상태',
  'conversation — 문자 기록',
  'tick — 틱 즉시 실행',
  'ff <minutes> — Fast Forward (ALLOW_FAST_FORWARD=true 일 때만)',
  'config — 실행 설정',
  'whoami — (admin bot) 내 chat id',
].join('\n');

export function formatForChat(name, result) {
  if (name === 'status') {
    if (!result.active) return '활성 시뮬레이션 없음';
    const r = result;
    return [
      `sim ${r.id} [${r.status}] phase=${r.phase}`,
      `world ${r.world_time} (+${r.elapsed_min}분, offset ${r.time_offset_min}분)`,
      `accident ${r.accident.status} @ ${r.accident.at}${r.accident.in_min != null ? ` (${r.accident.in_min}분 뒤)` : ''}`,
      `events: ${r.events.completed} done / ${r.events.scheduled} scheduled`,
      `msgs: out ${r.messages.sent} sent, ${r.messages.pending} pending / in ${r.messages.received}`,
      `sister: ${r.sister?.emotional_state} (stress ${r.sister?.stress}) @ ${r.sister?.location}, ${r.sister?.activity}; call=${r.sister?.can_call}; next check-in ${r.sister?.next_check_in}`,
      `truth: ${r.truth.mother_condition}${r.truth.injury ? ` | injury: ${r.truth.injury}` : ''}${r.truth.diagnosis ? ` | dx: ${r.truth.diagnosis}` : ''}`,
      `unresolved: ${r.unresolved_situations.join('; ') || '-'}`,
    ].join('\n');
  }
  if (name === 'events') {
    if (!result.length) return '사건 없음';
    return result.slice(-40).map((e) => `${e.status === 'completed' ? '✔' : e.status === 'scheduled' ? '…' : '✖'} ${e.occurred || e.scheduled} ${e.key}${e.fixed ? ' [fixed]' : ''}\n   ${e.description}`).join('\n');
  }
  if (name === 'character') {
    if (!result) return '없음';
    const s = result.state;
    return [
      `${s.display_name} @ ${s.location} — ${s.activity} (call ${s.can_call ? 'ok' : 'no'})`,
      `감정: ${s.emotional_state} / 스트레스 ${s.stress}`,
      `목표: ${s.goals.join('; ')}`, `의도: ${s.intentions.join('; ') || '-'}`,
      `아는 것(${s.knowledge.length}):`, ...s.knowledge.slice(-8).map((k) => ` · ${k.fact}`),
      `기억(${s.memory.length}):`, ...s.memory.slice(-5).map((m) => ` · ${m.text}`),
      `마지막 판단: ${result.last_deliberation ? `${result.last_deliberation.world_time} [${result.last_deliberation.trigger}] ${result.last_deliberation.output.inner_monologue}` : '-'}`,
    ].join('\n');
  }
  if (name === 'conversation') return result.length ? result.map((m) => `${m.world_time} ${m.direction === 'out' ? '지은' : '오빠'} [${m.status}]: ${m.text}`).join('\n') : '문자 없음';
  const text = JSON.stringify(result, null, 1);
  return text.length > 3500 ? text.slice(0, 3500) + '…' : text;
}
