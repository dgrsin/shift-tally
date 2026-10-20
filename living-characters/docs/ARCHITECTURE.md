# Architecture

## 선택: n8n Cloud 대신 경량 Node 백엔드

우선순위(작동 > 백그라운드 안정성 > 송수신 신뢰성 > 상태 보존 > 단순성 > 비용)에 n8n Cloud를 대보면
세 군데서 걸립니다. (1) 예약 정확도: Schedule Trigger는 분 단위이고, "시작 후 정확히 120분"처럼 실행 시점에
정해지는 일회성 타이머를 워크플로 안에서 안전하게 만들기 어렵습니다. (2) 동시성: 사용자 답장 처리와 월드 틱이
동시에 같은 상태를 읽고 쓰면 Data Tables에는 트랜잭션이 없어 경합이 생깁니다. (3) 상태: 인물의 지식·기억·대화,
사건의 인과관계처럼 구조가 있는 상태를 Data Tables에 JSON 문자열로 넣고 매 노드에서 파싱하면 워크플로가
금방 수십 노드로 불어납니다. 이 문제들은 모두 "하나의 프로세스가 하나의 SQLite 파일을 트랜잭션으로 다룬다"로
사라집니다. 그래서 MVP는 Node 22 단일 프로세스 + SQLite 입니다. n8n이 필요한 경우(알림, 대시보드)는
[N8N.md](N8N.md)에 적었습니다.

## 구성

```
                 ┌────────────────────────── process (src/main.js) ──────────────────────────┐
 Telegram ──poll─┤ poller(character) ─► Simulation.onUserMessage ─┐                          │
 (iPhone)        │                                                 ▼ (mutex)                 │
                 │ scheduler loop ──► Simulation.tick ──► World Engine ──► Character Engine   │
                 │   every 5s: due events?        │        (world.js)        (sister.js)      │
                 │   every 120s: world tick       │             │                 │           │
                 │                                │        events, truth     decision, msgs  │
                 │                                ▼             ▼                 ▼           │
                 │                           SQLite  ◄──────────┴─────────── outbox ─► send ─┼─► Telegram
 Admin bot ─poll─┤ poller(admin) ─► commands ◄── HTTP :8787 ◄── CLI                          │
                 └────────────────────────────────────────────────────────────────────────────┘
```

### World Engine (`src/engine/world.js`)
- `simulations.world_state`에 전지적 상태(장소, 인물 위치/상태, truth, 미해결 상황, 처리 대기 중인 인물 행동).
- `events` 테이블이 사건 로그이자 스케줄러. `fixed=1`인 사고 사건은 `createSimulation`에서 `start+120분`으로 삽입되고 취소 불가.
- `fireDueEvents`는 LLM 없이 DB만으로 도래한 사건을 `completed`로 바꿉니다. `occurred_world = scheduled_world`.
- `worldAdvance`는 LLM 호출: 입력은 전지적 상태 + 방금 발생한 사건 + 예정 사건 + 인물 행동 + 최근 문자. 출력은
  `phase`, `truth_updates`, `character_updates`, `new_events[]`(offset_min, description, perception_sister, visible_to),
  `cancel_event_keys`, `unresolved_situations`. 사건 key는 UNIQUE라 같은 전개를 두 번 만들 수 없습니다.
- 호출 시점: start, 사건 발생 직후, 인물 행동 직후, 그리고 예정 사건이 비었을 때 주기적으로. offset 0 사건은 같은 패스에서
  최대 3회까지 연쇄 처리(사고 → 즉시 증상 관찰).
- 정보 접근 범위: 사건마다 `description`(진실)과 `perceptions.sister`(지각)를 분리. 인물에게는 `visible_to`에 있을 때
  perception 텍스트만 `pending_perceptions`로 전달됩니다.

### Character Engine (`src/characters/sister.js`)
- 상태: personality(프로필, 정적), emotional_state, stress, knowledge[], memory[], relationships, goals, intentions,
  location/activity/can_call(세계가 갱신), pending_perceptions, next_check_in_world, last_contact_decision.
- `buildCharacterInput`이 프롬프트 입력을 만드는 유일한 경로이며 `world_state`를 받지 않습니다(세계가 갱신하는
  activity/can_call만 받음). 이것이 Knowledge Isolation의 구현입니다.
- 판단 트리거: 새 지각 / 안 읽은 사용자 문자 / 자기가 정한 check-in 시각. 출력 스키마에 `contact_decision`
  (should_contact, reason, channel text|call_wanted, urgency, consequence_if_not, already_told)이 있어 연락 판단이
  명시적으로 기록됩니다. 엔진은 `should_contact=false`면 메시지를 버리고, 통화 불가 상태면 `call_wanted`를 text로 내립니다.
- 행동(actions)은 `world_state.pending_character_actions`로 세계에 넘어가고, 세계가 결과를 사건으로 돌려줍니다.

### Communication Engine (`src/telegram/`)
- 송신: 판단 1회 = `deliberations` 1행 + `messages` N행(멱등키 `d:<id>:<i>`) 같은 트랜잭션. `flushOutbox`가 순서대로
  전송, `pause_sec`만큼 typing 표시 후 대기, 실패 시 지수 백오프(최대 8회), 성공 후 `telegram_message_id` 기록.
- 수신: long polling, offset은 `kv`에 영속, `inbound_updates`로 update_id 중복 제거, `ALLOWED_CHAT_ID` 외 무시(응답도 안 함).
  디바운스 6초로 연속 문자를 한 번에 읽습니다.
- 관리 채널은 별도 봇/HTTP라 캐릭터 대화에 섞이지 않습니다.

### 시간
- `worldNow = real + offset` (paused면 `paused_at + offset`). resume 시 멈춘 시간만큼 offset을 빼서 연속성 유지.
- Fast Forward는 목표 시각까지 "다음 도래 지점(예정 사건, check-in, 주기 advance)"으로 점프하며 틱을 돌립니다.
  순서가 실제와 같아 리허설 결과가 실전과 구조적으로 같습니다. `ALLOW_FAST_FORWARD=false`면 거부.
- 프로세스가 죽어 있던 동안의 사건은 재기동 직후 예정 시각으로 기록됩니다. 지은은 그것들을 한 번에 지각합니다
  (오래 꺼져 있었다면 "한꺼번에 알게 된" 상태가 되는 것은 의도된 한계).

### LLM 호출 (`src/llm/client.js`)
- `client.beta.messages.parse` + `jsonSchemaOutputFormat` (structured outputs). 시스템 프롬프트는 `cache_control`로
  캐시되고, 가변 정보는 user 메시지에만 들어갑니다.
- 기본 모델 `claude-opus-5-5`, `output_config.effort=medium`. 서버측 refusal fallback(`fallbacks: "default"`)을 기본으로 켭니다.
- 오류 분류: 429/5xx/연결 오류는 재시도, 400/401은 즉시 실패. 실패해도 시뮬레이션은 멈추지 않고 다음 주기에 재시도.

## 보안·시연 조건
- 실제 외부 연락 없음: 코드가 호출하는 외부 API는 Anthropic과 Telegram뿐.
- 허용 chat id 하나에만 전송, 다른 사람의 메시지는 응답 없이 폐기.
- 비밀값은 환경변수. 저장되는 개인정보는 사용자의 chat id와 사용자가 보낸 문자뿐.
- 봇 프로필은 가상 인물. 실존 인물 계정 사칭 기능 없음.

## 알려진 한계 / 다음 단계
- 전화는 못 겁니다. "통화 가능해?"라는 문자로 표현되고, 통화 자체는 일어나지 않습니다.
- 인물은 지은 한 명. 어머니는 세계가 관리하는 상태입니다. 둘째 인물을 추가하려면 `characters/` 아래 같은 구조로 파일을 하나 더 만들고
  `deliverPerceptions`의 visible_to 처리를 일반화하면 됩니다.
- 전송 성공 후 DB 기록 전에 프로세스가 죽으면(수 ms 창) 재기동 시 1회 중복 전송이 가능합니다.
- LLM이 장시간 실패하면 세계의 비확정 전개가 늦어집니다(확정 사고는 영향 없음).
