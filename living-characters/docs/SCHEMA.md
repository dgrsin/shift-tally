# Data Schema

SQLite 한 파일(`DB_PATH`, 기본 `data/living.db`, WAL). 정의는 `src/db/db.js`.

## simulations
| column | 설명 |
|---|---|
| id | `sim_YYYYMMDDHHMMSS_xxxxxx` |
| status | running / paused / ended / reset |
| started_at_real | 시작 실제 시각(ms). `simulation_start_time` |
| time_offset_ms | 세계 = 실제 + offset. fast-forward/pause 누적 |
| paused_at_real | 일시정지 시각 |
| last_tick_world | 마지막 틱의 세계 시각 (`last_tick_time`) |
| last_world_advance_world | 마지막 World Engine LLM 호출의 세계 시각 |
| world_state | JSON, 아래 참조 (`world_state`, `unresolved_situations`, `pending_actions`) |

`kv.active_sim` 이 현재 시뮬레이션 id. `current_world_time`은 저장하지 않고 `worldNow()`로 계산(재시작에 안전).

### world_state JSON
```json
{
  "scenario": "family_emergency",
  "phase": "pre_accident | accident | ambulance | er_waiting | exam | results | aftermath | settled",
  "places": { "sister_home": "...", "hospital": "중앙병원", "mother_home": "..." },
  "characters": {
    "sister": { "location": "sister_home", "activity": "...", "can_call": true },
    "mother": { "location": "sister_home", "status": "..." },
    "user":   { "note": "본인이 말한 것만 기록" }
  },
  "truth": { "injury": "", "diagnosis": "", "mother_condition": "", "notes": [] },
  "unresolved_situations": [],
  "pending_character_actions": [ { "character": "sister", "description": "...", "duration_min": 3, "world_time": 0 } ]
}
```

## events (scheduled_events + completed_events + event log)
| column | 설명 |
|---|---|
| key | 멱등키, (sim_id, key) UNIQUE. 확정 사고는 `fixed:accident` |
| type | accident / ambient / arrival / transit / medical / observation / … |
| status | scheduled / completed / cancelled |
| fixed | 1이면 확정 사건(취소 불가) |
| scheduled_world | 발생 예정 세계 시각 |
| occurred_world | 기록된 발생 시각 (= scheduled_world) |
| fired_real | 엔진이 처리한 실제 시각 (지연 측정용) |
| payload | `{ description(전지적), perceptions: { sister: "지각 텍스트" } }` |
| caused_by | 원인 사건 id (인과관계) |
| visible_to | 지각하는 인물 배열 |

## characters (character_states / knowledge / memories / emotions / relationships)
`state` JSON:
```json
{
  "name": "sister", "display_name": "지은",
  "location": "...", "activity": "...", "can_call": true,
  "emotional_state": "...", "stress": 0,
  "knowledge": [ { "fact": "...", "source": "직접 경험|오빠 문자|의사 말|추측", "at": 0 } ],
  "memory":    [ { "text": "...", "at": 0 } ],
  "goals": [], "intentions": [],
  "relationships": { "user": { "label": "오빠", "trust": 80 }, "mother": { "label": "엄마", "trust": 90 } },
  "pending_perceptions": [ { "event_id": 1, "key": "...", "world_time": 0, "text": "..." } ],
  "next_check_in_world": 0,
  "last_contact_decision": { "at": "22:58", "should_contact": true, "channel": "call_wanted", "urgency": "high", "reason": "..." },
  "deliberation_count": 0
}
```

## deliberations
인물의 판단 1회. `input`은 그녀가 본 프롬프트 입력 전문(격리 검증에 사용), `output`은 스키마(`CHARACTER_DECISION_SCHEMA`) JSON.

## messages (conversation_history + outbox)
| column | 설명 |
|---|---|
| direction | out(지은→사용자) / in(사용자→지은) |
| status | out: pending / sent / failed · in: received / read |
| idempotency_key | out: `d:<deliberation_id>:<index>` · in: `in:<update_id>` |
| telegram_message_id, telegram_update_id | 텔레그램 식별자 |
| attempts, next_attempt_real, last_error | 재시도 상태 |
| delay_ms | 말풍선 전 자연스러운 대기 |

## inbound_updates / kv
`inbound_updates`: 처리한 Telegram update_id. `kv`: `active_sim`, `tg_offset:character`, `tg_offset:admin`.

## LLM 출력 스키마
`src/engine/schemas.js` — `WORLD_ADVANCE_SCHEMA`, `CHARACTER_DECISION_SCHEMA`. 둘 다 `additionalProperties:false`로 고정되어
엔진이 모양을 신뢰합니다.
