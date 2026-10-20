# n8n Cloud 검토와 연동 방법

## 왜 핵심 루프는 n8n에 두지 않았나
- 예약 정확도: 시작 시점에 결정되는 "정확히 120분 뒤" 일회성 사건을 n8n에서는 Wait 노드(실행을 붙잡음)나 분 단위 Schedule
  Trigger + 매번 DB 조회로 흉내 내야 합니다. 둘 다 실행 지연·중복 실행 위험이 있고, Cloud 플랜의 실행 횟수 과금에 그대로 잡힙니다.
- 동시성: Telegram Trigger(답장)와 Schedule Trigger(틱)가 동시에 같은 상태를 수정할 때 Data Tables에는 트랜잭션/락이 없습니다.
- 상태 모델: 지식·기억·사건 인과관계처럼 구조가 있는 상태를 Data Tables에 넣으면 노드마다 JSON 파싱·병합 코드가 붙어 워크플로가 비대해집니다.
- 지식 격리 검증: 인물 프롬프트에 무엇이 들어갔는지 기록·테스트해야 하는데, 코드 쪽이 훨씬 단순합니다.

## n8n을 쓰기 좋은 자리 (선택)
백엔드의 관리 HTTP API(`POST /status`, `/events`, `/character`, `Authorization: Bearer <ADMIN_TOKEN>`)는 n8n HTTP Request 노드로
그대로 호출할 수 있습니다. 예:
1. **운영 알림**: Schedule Trigger(10분) → HTTP Request `/status` → IF `messages.pending > 0` 또는 `status != running` → Slack/Email.
2. **대시보드**: `/events`, `/conversation` 결과를 Google Sheets/Notion에 적재.
3. **원격 시작**: Webhook 노드 → HTTP Request `/start`. (ADMIN_TOKEN을 n8n Credentials에 보관)

이 경우 백엔드를 공개 네트워크에 노출해야 하므로 fly.io라면 `[[services]]`를 추가하고 반드시 HTTPS + 토큰으로만 접근하게 하십시오.
핵심 루프(시간, 사건, 인물 판단, 송수신)는 백엔드 하나에 있어야 상태 보존과 멱등성이 보장됩니다.
