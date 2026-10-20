// Rule-based stand-in for the LLM. Used by tests and `LLM_PROVIDER=mock` dry runs.
// It mirrors the *shape* of a plausible story so the engine logic can be exercised
// end-to-end without an API key. It is deliberately simple, not clever.
import { elapsedMin } from '../engine/clock.js';

export async function mockComplete(req) {
  const ctx = req.context || {};
  if (ctx.kind === 'world') return mockWorld(ctx, req);
  if (ctx.kind === 'character') return mockCharacter(ctx, req);
  throw new Error('mock: unknown request kind');
}

function hasFired(ctx, key) { return (ctx.fired || []).some((e) => e.key === key); }

function mockWorld(ctx) {
  const ws = ctx.world_state;
  const base = {
    narration: '', phase: ws.phase,
    truth_updates: { injury: '', diagnosis: '', mother_condition: '', notes: [] },
    character_updates: { sister: { ...ws.characters.sister }, mother: { ...ws.characters.mother } },
    new_events: [], cancel_event_keys: [], unresolved_situations: ws.unresolved_situations || [],
  };
  if (ctx.trigger === 'start') {
    base.narration = '평범한 저녁. 일상 사건 둘.';
    base.new_events = [
      { key: 'dinner_starts', type: 'ambient', offset_min: 25, description: '모녀가 저녁을 먹기 시작한다.', perception_sister: '엄마랑 저녁 먹기 시작함. 엄마가 찌개 간이 싱겁다고 하심.', visible_to: ['sister'] },
      { key: 'mother_packs_food', type: 'ambient', offset_min: 80, description: '어머니가 반찬을 싸 준다.', perception_sister: '엄마가 반찬통에 김치랑 멸치볶음 싸주심. 오빠네도 갖다주라고 하심.', visible_to: ['sister'] },
    ];
    return base;
  }
  if (hasFired(ctx, 'fixed:accident')) {
    base.narration = '사고 확정. 숨은 진실: 왼쪽 손목 원위 요골 골절, 왼쪽 엉덩이 타박.';
    base.phase = 'accident';
    base.truth_updates = {
      injury: '왼쪽 손목 원위 요골 골절(전위 없음) + 왼쪽 엉덩이·허벅지 타박. 고관절 골절은 아님.',
      diagnosis: '손목 골절 → 부목 고정 후 정형외과 외래. 엉덩이는 엑스레이상 이상 없음. 당일 귀가 가능.',
      mother_condition: '층계참에 앉아 있음. 손목 통증 심함. 엉덩이 통증으로 체중 지지 어려움. 의식 명료.',
      notes: ['혈압약 복용 중 — 응급실에서 확인 예정'],
    };
    base.character_updates.sister = { location: 'sister_home', activity: '엄마 곁에 앉아 상태 확인 중', can_call: true };
    base.character_updates.mother = { location: 'sister_home_stairs', status: '층계참에 앉아 왼손목과 엉덩이를 잡고 아파함' };
    base.new_events = [
      { key: 'immediate_symptoms', type: 'observation', offset_min: 0, description: '지은이 엄마의 상태를 살핀다.', perception_sister: '엄마가 왼쪽 손목을 꼭 잡고 계심. 손목이 부어오르는 게 보임. 엉덩이도 아프다고 하시고 다리에 힘을 못 주심. 정신은 멀쩡하시고 말씀도 하심.', visible_to: ['sister'] },
    ];
    base.unresolved_situations = ['어머니 부상, 119 신고 여부는 지은의 결정'];
    return base;
  }
  // character actions -> consequences
  const acts = (ws.pending_character_actions || []).map((a) => a.description).join(' ');
  if (/119/.test(acts) && ws.phase === 'accident') {
    base.narration = '119 신고 접수. 구급차 출동.';
    base.phase = 'ambulance';
    base.new_events = [
      { key: 'ambulance_arrives', type: 'arrival', offset_min: 9, description: '구급차 도착. 구급대원이 어머니 상태를 확인한다.', perception_sister: '구급차 왔음. 구급대원 두 명이 엄마 상태 보더니 손목 부목 대고 들것에 옮김. 중앙병원으로 간다고 함.', visible_to: ['sister'] },
      { key: 'ambulance_departs', type: 'transit', offset_min: 14, description: '구급차 출발. 지은 동승. 차 안에서는 통화 불가.', perception_sister: '구급차 타고 출발함. 구급대원이 엄마한테 계속 뭐 물어봄. 차 안이 시끄러워서 통화는 못 할 것 같음.', visible_to: ['sister'] },
      { key: 'er_arrival', type: 'arrival', offset_min: 32, description: '중앙병원 응급실 도착. 접수와 분류.', perception_sister: '중앙병원 응급실 도착. 접수했고 엄마는 침대에 누우심. 간호사가 혈압약 뭐 드시는지 물어봄.', visible_to: ['sister'] },
      { key: 'xray_ordered', type: 'medical', offset_min: 50, description: '응급의가 손목·골반 엑스레이 처방.', perception_sister: '의사가 와서 손목이랑 엉덩이 쪽 엑스레이 찍자고 함. 결과는 좀 기다려야 한다고.', visible_to: ['sister'] },
      { key: 'xray_results', type: 'medical', offset_min: 95, description: '엑스레이 결과: 왼쪽 손목 골절(전위 없음), 골반 이상 없음.', perception_sister: '의사 말로는 손목은 금이 가서(골절) 부목 대고 정형외과 외래 보면 되고, 엉덩이는 뼈는 괜찮대. 오늘 집에 가도 된다고 함.', visible_to: ['sister'] },
    ];
    base.character_updates.sister = { location: 'sister_home', activity: '구급차 기다리며 엄마 곁에 있음', can_call: true };
    base.unresolved_situations = ['구급차 대기'];
    return base;
  }
  if (hasFired(ctx, 'ambulance_departs')) {
    base.phase = 'ambulance'; base.character_updates.sister = { location: 'ambulance', activity: '구급차 동승', can_call: false }; base.narration = '이송 중';
    base.character_updates.mother = { location: 'ambulance', status: '들것에 누움, 통증 호소' };
    return base;
  }
  if (hasFired(ctx, 'er_arrival')) {
    base.phase = 'er_waiting'; base.character_updates.sister = { location: 'hospital', activity: '응급실 보호자 대기', can_call: true }; base.narration = '응급실';
    base.character_updates.mother = { location: 'hospital', status: '응급실 침대' };
    return base;
  }
  if (hasFired(ctx, 'xray_ordered')) { base.phase = 'exam'; base.narration = '검사'; return base; }
  if (hasFired(ctx, 'xray_results')) {
    base.phase = 'results'; base.narration = '결과 설명됨';
    base.new_events = [
      { key: 'splint_done', type: 'medical', offset_min: 40, description: '부목 고정 완료. 퇴원 수속 안내.', perception_sister: '부목 다 했고 처방전 받으면 집에 가도 된다고 함. 엄마 좀 진정하심.', visible_to: ['sister'] },
    ];
    base.unresolved_situations = ['퇴원 후 엄마를 어디로 모실지'];
    return base;
  }
  if (hasFired(ctx, 'splint_done')) { base.phase = 'aftermath'; base.narration = '퇴원 준비'; base.unresolved_situations = ['퇴원 후 엄마를 어디로 모실지']; return base; }
  base.narration = '변화 없음';
  return base;
}

function mockCharacter(ctx) {
  const st = ctx.state;
  const perc = (st.pending_perceptions || []).map((p) => p.text).join(' ');
  const inbound = (ctx.inbound || []).map((m) => m.text).join(' ');
  const out = {
    inner_monologue: '', situation_assessment: '', emotional_state: st.emotional_state, stress: st.stress,
    contact_decision: { should_contact: false, reason: '', channel: 'none', urgency: 'none', consequence_if_not: '', already_told: false },
    messages: [], actions: [], knowledge_updates: [], memory_entry: '', goals: st.goals, intentions: st.intentions, next_check_in_min: 30,
  };
  const say = (texts, { channel = 'text', urgency = 'medium', reason = '' } = {}) => {
    out.contact_decision = { should_contact: true, reason, channel, urgency, consequence_if_not: '', already_told: false };
    out.messages = texts.map((t, i) => ({ text: t, pause_sec: i === 0 ? 0 : 4 }));
  };
  if (inbound) {
    out.inner_monologue = '오빠 답장';
    if (/병원/.test(inbound)) say(['중앙병원'], { reason: '오빠가 물어봄' });
    else if (/갈게|간다|가고 있/.test(inbound)) { say(['응 알았어', '조심히 와'], { reason: '오빠가 온다고 함' }); out.knowledge_updates.push({ fact: '오빠가 병원으로 오겠다고 했다 (도착은 아직 모름)', source: '오빠 문자' }); }
    else if (/의사|뭐래|결과/.test(inbound)) say([st.knowledge.some((k) => /골절/.test(k.fact)) ? '손목 골절이래 부목 대고 외래 보면 된대' : '아직 결과 안 나왔어'], { reason: '질문' });
    else if (/전화/.test(inbound) && !st.can_call) say(['지금은 통화 힘들어 문자로 해'], { reason: '통화 불가' });
    else say(['응'], { reason: '답', urgency: 'low' });
    out.next_check_in_min = 15;
    return out;
  }
  if (/넘어지/.test(perc)) {
    out.inner_monologue = '엄마가 넘어지셨다. 119 먼저.';
    out.stress = 80; out.emotional_state = '놀람, 당황';
    out.actions = [{ description: '119에 신고하고 엄마 곁을 지킨다', duration_min: 3 }];
    say(['오빠 지금 통화 가능해?'], { channel: 'call_wanted', urgency: 'high', reason: '엄마 사고' });
    out.memory_entry = '엄마가 계단에서 넘어지셨다. 119 불렀다.';
    out.next_check_in_min = 5;
    return out;
  }
  if (/중앙병원으로 간다/.test(perc)) { say(['엄마 계단에서 넘어지셨어', '구급차 타고 중앙병원 가'], { urgency: 'high', reason: '이송 알림' }); out.stress = 75; out.next_check_in_min = 10; return out; }
  if (/응급실 도착/.test(perc)) { say(['응급실 도착했어 접수함'], { urgency: 'medium', reason: '도착' }); out.stress = 65; out.next_check_in_min = 15; return out; }
  if (/골절/.test(perc)) { say(['손목 골절이래', '엉덩이는 뼈 괜찮대 오늘 집에 가도 된대'], { urgency: 'medium', reason: '결과' }); out.stress = 45; out.emotional_state = '안도'; out.next_check_in_min = 20; return out; }
  if (/반찬/.test(perc)) { say(['엄마가 오빠네 김치 싸놓으심 언제 가져갈래ㅋㅋ'], { urgency: 'low', reason: '소소한 소식' }); out.next_check_in_min = 60; return out; }
  out.inner_monologue = '별일 없음';
  out.next_check_in_min = ctx.sim?.world_state?.phase === 'pre_accident' ? 45 : 12;
  return out;
}
