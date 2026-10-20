# Living Characters — Family Emergency MVP

사용자와 대화하지 않는 동안에도 가상 세계가 실제 시간으로 진행되고, 그 세계의 인물(막내딸 "지은")이
자기 판단으로 텔레그램 메시지를 보내는 시스템입니다. 첫 시나리오는 *Family Emergency*:
시작 120분 뒤 어머니가 막내딸 집 계단에서 넘어지는 확정 사건이 일어나고, 그 뒤의 이야기는 세계 상태와
인물의 판단으로 생성됩니다.

- 실행 가능한 코드: Node.js 22 단일 프로세스, SQLite(내장 `node:sqlite`), 외부 의존성은 `@anthropic-ai/sdk` 하나
- 세 엔진 분리: **World Engine** (`src/engine/world.js`) / **Character Engine** (`src/characters/sister.js`) / **Communication Engine** (`src/telegram/`)
- 프롬프트: `prompts/world_engine.md`, `prompts/character_sister.md`, 인물 프로필 `prompts/characters/sister.json`
- 설계 문서: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 데이터 스키마: [docs/SCHEMA.md](docs/SCHEMA.md), n8n 검토: [docs/N8N.md](docs/N8N.md)

이 시스템의 응급 상황은 전부 가상입니다. 실제 119, 병원, 제3자에게는 아무것도 보내지 않습니다.
메시지는 `ALLOWED_CHAT_ID` 한 곳에만 전송되며, 봇 프로필은 시연용 가상 인물("지은")입니다.

---

## 1. 준비물 (외부 서비스)

| 항목 | 어디서 | 환경변수 |
|---|---|---|
| Claude API 키 | https://console.anthropic.com/ | `ANTHROPIC_API_KEY` |
| 캐릭터 봇 토큰 | 텔레그램 `@BotFather` → `/newbot` → 이름 **지은** (username은 아무거나, 예: `jieun_lc_bot`) | `TELEGRAM_BOT_TOKEN` |
| 본인 chat id | 아래 2단계 | `ALLOWED_CHAT_ID` |
| (권장) 관리 봇 토큰 | `@BotFather` → `/newbot` 한 번 더 (예: `lc_admin_bot`) | `ADMIN_BOT_TOKEN`, `ADMIN_CHAT_IDS` |
| 관리 API 토큰 | 아무 긴 난수 (`openssl rand -hex 24`) | `ADMIN_TOKEN` |

BotFather에서 캐릭터 봇에 `/setuserpic`으로 프로필 사진, `/setdescription`은 비워 두거나 "가족 시연용 캐릭터"로 두면 됩니다.
`/setprivacy`는 기본값(Enabled)이면 됩니다. 1:1 채팅만 사용합니다.

## 2. 설치와 첫 실행 (로컬)

```bash
cd living-characters
npm install
cp .env.example .env     # 값 채우기
npm test                 # API 키 없이 돌아가는 오프라인 테스트 10개
npm start
```

처음에는 `ALLOWED_CHAT_ID`를 모릅니다. 아이폰 텔레그램에서 캐릭터 봇을 찾아 아무 말이나 보낸 뒤 로그를 보면
`message from non-allowed chat 123456789 ... ignored`가 찍힙니다. 그 숫자를 `ALLOWED_CHAT_ID`에 넣고 재시작합니다.
관리 봇을 만들었다면 관리 봇에 `/whoami`를 보내면 chat id를 알려줍니다. 같은 값을 `ADMIN_CHAT_IDS`에 넣습니다.

## 3. 시뮬레이션 시작·조작

세 가지 관리 인터페이스가 같은 명령을 공유합니다 (`src/admin/commands.js`).

```bash
# CLI (관리 HTTP API 호출)
npm run admin -- start          # 새 시뮬레이션. 지금부터 120분 뒤 사고
npm run admin -- status         # 세계 시각, 단계, 사고까지 남은 시간, 메시지 수, 지은의 상태
npm run admin -- events 50      # 사건 로그 (예정/완료, 원인 사건, 지은이 지각한 내용)
npm run admin -- character      # 지은의 내부 상태 (감정, 지식, 기억, 마지막 판단)
npm run admin -- conversation   # 문자 기록
npm run admin -- pause | resume | reset
npm run admin -- ff 125         # Fast Forward (ALLOW_FAST_FORWARD=true 일 때만)
npm run admin -- tick           # 틱 즉시 실행
```

관리 봇(텔레그램)에서는 같은 단어를 그대로 보냅니다: `start`, `status`, `events`, `character`, `ff 125`, `help`.
HTTP로 직접: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8787/status`.

일반 대화(캐릭터 봇)에는 관리 명령이나 디버그 정보가 절대 나타나지 않습니다.

### 시연 절차

1. 서버가 떠 있는지 확인: `npm run admin -- status` 또는 관리 봇 `status`.
2. `ALLOW_FAST_FORWARD=false`로 두고 `start`.
3. 120분 동안 지은은 사고를 모릅니다. 소소한 문자가 한 번쯤 올 수도, 안 올 수도 있습니다.
4. 사고 시각에 사건이 기록되고, 지은이 상황을 수습하다가 자기 판단으로 연락합니다. 연락까지의 시간은 그녀가 정합니다.
5. 답장하면 그 내용이 지은의 지식에 들어가고 이후 행동이 바뀝니다. 답하지 않아도 세계는 계속 갑니다.
6. 관객에게 보여줄 내부 상태는 관리 봇/CLI의 `status`, `events`, `character`로 확인합니다.

### 오프라인 리허설

```bash
npm run simulate                       # mock LLM + mock Telegram, 5시간을 몇 초로 압축
LLM_PROVIDER=claude npm run simulate   # 실제 Claude로 대본 생성 (텔레그램 없음, 토큰 소모)
```

## 4. 24시간 실행 (사용자 컴퓨터가 꺼져 있어도)

프로세스 하나가 계속 떠 있어야 합니다. 권장 순서:

**A. fly.io (가장 간단한 상시 실행, 월 2~3달러)** — `fly.toml` 포함
```bash
fly launch --no-deploy --copy-config --name living-characters
fly volumes create lc_data --size 1 --region nrt
fly secrets set ANTHROPIC_API_KEY=... TELEGRAM_BOT_TOKEN=... ALLOWED_CHAT_ID=... ADMIN_TOKEN=... ADMIN_BOT_TOKEN=... ADMIN_CHAT_IDS=...
fly deploy
fly logs
# CLI 쓰려면: fly proxy 8787:8787  →  ADMIN_URL=http://127.0.0.1:8787 npm run admin -- status
```
**B. Docker가 있는 아무 VPS / 홈서버 / 맥미니**
```bash
docker compose up -d --build && docker compose logs -f
```
**C. 맥에서 직접** — `npm start`를 `launchd`나 `pm2`로. 단, 맥이 잠들면 멈춥니다(시연 중 `caffeinate -i npm start`).

Railway/Render도 됩니다. 조건은 두 가지뿐입니다: 항상 켜져 있을 것, `data/` 디렉터리가 영속 볼륨일 것.
외부 포트는 열 필요가 없습니다(텔레그램은 long polling, 관리 API는 내부용).

## 5. 동작 원리 요약

- 세계 시각 = 실제 시각 + offset. pause는 offset으로 시간을 얼리고, fast forward는 offset을 더합니다. 1:1 흐름.
- `SCHEDULER_POLL_SEC`(5초)마다 예정 사건의 도래를 확인하고, `TICK_INTERVAL_SEC`(120초)마다 World Tick을 돕니다.
- 사건 발생은 DB만으로 처리됩니다(LLM이 죽어도 사고는 제시각에 기록). 기록 시각은 *예정 시각*이라 인프라 지연이 사고 시각을 밀지 않습니다.
- World Engine LLM은 사건이 발생했을 때, 인물이 행동했을 때, 그리고 예정된 전개가 없을 때만 호출됩니다.
- Character Engine LLM은 새 지각이 있을 때, 사용자 문자가 왔을 때, 스스로 정한 check-in 시각이 됐을 때만 호출됩니다. 연락 여부·시점·내용은 그 호출의 출력입니다.
- 지은의 프롬프트에는 그녀의 상태·지각·대화만 들어갑니다. 세계의 truth나 예정 사건은 들어가지 않습니다(테스트 1, 9가 이를 검사).
- 메시지는 outbox에 저장된 뒤 전송됩니다. 실패하면 백오프 재시도, 성공 후에는 절대 재전송하지 않습니다. 사용자 메시지는 `update_id`로 중복 제거합니다.

예상 비용: Opus 5.5 기준 5시간 시연에 LLM 호출 25~40회, 호출당 수천 토큰 → 대략 2~5달러.
`LLM_MODEL=claude-sonnet-5-5`로 낮추면 1/2 이하.

## 6. 문제가 생겼을 때

| 증상 | 확인 | 조치 |
|---|---|---|
| 메시지가 안 옴 | `status`의 `msgs pending`, 로그의 `send #N failed` | 토큰/`ALLOWED_CHAT_ID` 확인. outbox는 자동 재시도(최대 8회, 최대 10분 간격). 재시작하면 즉시 재시도 |
| 봇이 내 말에 반응 없음 | 로그 `non-allowed chat` | 그 chat id를 `ALLOWED_CHAT_ID`에 설정 |
| `getUpdates failed 409` | 같은 토큰으로 두 프로세스가 폴링 중 | 하나만 남기기 |
| LLM 오류 (`deliberation failed`, `world advance failed`) | 로그 | 자동 복구: 지은은 5분 뒤 다시 생각하고 지각/문자는 보존됨. 세계는 다음 주기에 재시도. 사고 발생 자체는 LLM과 무관 |
| 프로세스 재시작/서버 재부팅 | `resuming sim_... world=...` 로그 | 아무것도 안 해도 됨. 세계 시각은 실제 시각 기준이라 꺼져 있던 동안의 사건은 재기동 직후 제시각으로 기록·처리됨 |
| 시뮬레이션이 꼬임 | `events`, `character` | `pause` 후 점검 → `resume`, 또는 `reset` 후 `start` |
| DB가 깨짐 | `data/living.db` | 백업본으로 교체 또는 삭제 후 `start`(새 시뮬레이션) |
| 시연 전 리허설하고 싶음 | | `LLM_PROVIDER=mock TELEGRAM_TRANSPORT=mock npm start` 후 `ff 125` |

DB 백업은 파일 복사면 됩니다: `sqlite3 data/living.db ".backup data/backup.db"` 또는 프로세스를 멈추고 `cp`.

## 7. 파일 구조

```
src/main.js                 프로세스 진입: DB, 폴러, 스케줄러, 관리 API
src/config.js               환경변수
src/db/db.js                SQLite 스키마/트랜잭션
src/engine/clock.js         세계 시각 (offset, pause, fast-forward)
src/engine/world.js         World Engine: 상태, 확정/생성 사건, 인과관계, LLM advance
src/engine/schemas.js       LLM 구조화 출력 스키마
src/engine/simulation.js    오케스트레이터: tick, 사건 발생 → 세계 → 인물 → 전송, 수신 처리, FF
src/characters/sister.js    Character Engine: 상태, 지식 격리된 입력 구성, 판단, 적용
src/llm/client.js           Claude 호출 (structured outputs, prompt caching, refusal fallback, 재시도)
src/llm/mock.js             오프라인 규칙 기반 대역
src/telegram/api.js         Bot API 클라이언트 + mock
src/telegram/poller.js      long polling (offset 영속, update_id 중복 제거)
src/telegram/outbox.js      Communication Engine 송신: outbox, 멱등성, 재시도, 말풍선 간격
src/admin/*                 관리 명령 (HTTP, 관리 봇, CLI 공용)
prompts/                    시스템 프롬프트와 인물 프로필 (여기만 고쳐도 성격이 바뀜)
test/                       사양서 13절 검증 항목
scripts/admin.js            CLI
scripts/simulate-offline.js 리허설
```
