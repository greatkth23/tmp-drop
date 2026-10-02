# 운영 준비와 장애 대응

이 문서는 운영 절차입니다. 실제 staging 생성·배포·검증 기록은 `STAGING_VALIDATION.md`에 있습니다. production은 아직 배포하지 않았습니다. 출시 차단 항목은 `IMPLEMENTATION_STATUS.md`에 있습니다.

## 환경 분리와 배포 순서

1. 로컬용 `.dev.vars` 비밀과 DB·버킷을 운영에 재사용하지 않습니다.
2. Cloudflare 계정에서 staging과 production의 Worker, D1, R2를 각각 생성합니다. 각 환경은 서로 다른 비밀과 도메인을 사용합니다.
3. `wrangler.production.example.jsonc`를 `wrangler.production.jsonc`로 복사해 실제 DB UUID, account ID, bucket 이름, HTTPS 도메인을 넣습니다. staging도 별도 구성 파일을 사용합니다.
4. R2는 비공개로 유지합니다. `r2.dev` 공개 접근과 R2 public custom domain은 끕니다. 서비스 UI는 Worker custom domain을 사용합니다. R2 서명용 credential은 해당 환경의 단일 bucket에 한정합니다.
5. 아래 비밀을 Worker secrets로 입력합니다. 운영용 TOTP는 운영자 Authenticator에 등록하고 로컬 코드 생성 도구에 운영 비밀을 넣지 않습니다.

| Secret               | 용도                                                   |
| -------------------- | ------------------------------------------------------ |
| TOTP_SECRET          | SHA-1, 6자리, 30초 TOTP의 Base32 seed                  |
| DOWNLOAD_PIN         | 문자열 4자리 숫자                                      |
| CSRF_SECRET          | 32바이트 이상 임의값, CSRF 서명과 PIN 비교 HMAC        |
| IP_HASH_SECRET       | 32바이트 이상 임의값, IP 비식별 키                     |
| IDEMPOTENCY_SECRET   | 32바이트 임의값, 생성 응답 AES-GCM 암호화              |
| R2_ACCESS_KEY_ID     | bucket 한정 S3 API access key                          |
| R2_SECRET_ACCESS_KEY | 대응 S3 API secret                                     |
| STAGING_GATE_SECRET  | staging의 모든 페이지·API를 보호하는 별도 임의 접근 키 |

```powershell
npx wrangler secret put TOTP_SECRET --config wrangler.production.jsonc
```

나머지 secret도 같은 방식으로 입력합니다. 값이 명령줄 기록·로그·저장소에 남지 않도록 secret put의 입력 프롬프트를 사용합니다. `APP_ORIGIN`은 trailing slash 없는 정확한 HTTPS origin입니다.

6. staging에서 schema, 64 MiB part, 조건부 CopyObject, direct GET·Range, 만료·폐기·정리·failure injection을 검증합니다. 실기기·대용량 검증을 완료한 뒤 운영 구성 검사를 수행합니다.

```powershell
npm run config:production
npm run check
npx wrangler deploy --dry-run --config wrangler.production.jsonc
```

7. 새 DB에 migration을 적용한 후 배포합니다. 기존 DB에서는 변경 전 복원 지점을 확보하고 additive migration부터 적용합니다.

```powershell
npx wrangler d1 migrations apply temporary-drop-production --remote --config wrangler.production.jsonc
npx wrangler deploy --config wrangler.production.jsonc
```

8. 운영 주소에서 인증 전 metadata 비노출, PIN·TOTP, 작은 검증 파일, 기기 폐기, cron 실행·삭제를 확인합니다. 이후 테스트 기기의 credential을 폐기합니다.

운영 구성 검사 스크립트는 공개 설정의 오타를 검사합니다. 비밀 값의 존재·품질, R2 공개 설정, 과금, 실기기 검증을 대신하지 않습니다. 현재 CI는 타입·포맷·테스트·빌드·dry-run만 수행합니다. 자동 배포와 원격 CI 실행은 아직 설정하지 않았습니다.

## 정리와 lifecycle

애플리케이션 정리는 15분 cron으로 실행합니다. 실행당 삭제 최대 10개, FINALIZING 복구 최대 3개, 뒤늦게 다시 생긴 staging 삭제 최대 10개입니다. 삭제 실패는 15분 뒤 다시 처리합니다. staging 재정리는 마지막 처리 시간순으로 순환해 앞의 10개에 고정되지 않습니다.

READY의 논리 만료는 HTTP 요청 시 바로 적용됩니다. cron 지연이 파일 목록·신규 다운로드 URL 발급 기간을 늘리지 않습니다. 물리 삭제 지연 중에는 quota를 유지합니다. 완료 URL 발급과 이미 열린 전송의 즉시 취소는 별개입니다.

다음은 신규 전용 bucket의 fallback 규칙 제안입니다. 기존 bucket에 적용할 때는 기존 규칙을 먼저 확인합니다. 이 명령들은 아직 실행하지 않았습니다.

```powershell
npx wrangler r2 bucket lifecycle add temporary-drop-production final-fallback final/ --expire-days 7
npx wrangler r2 bucket lifecycle add temporary-drop-production staging-fallback staging/ --expire-days 2
npx wrangler r2 bucket lifecycle add temporary-drop-production multipart-fallback final/ --abort-multipart-days 1
npx wrangler r2 bucket lifecycle list temporary-drop-production
```

Lifecycle은 애플리케이션의 분 단위 만료·삭제를 대신하지 않습니다. 미완료 multipart와 staging의 잔여 객체에 대한 안전망입니다. 시간과 과금 의미는 [R2 lifecycle 문서](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)를 기준으로 운영 환경에서 확인합니다.

staging에는 `staging/` 1일 만료, `final/` 7일 만료와 미완료 multipart 1일 중단 규칙을 실제 적용했습니다. 기본 multipart 7일 중단 규칙도 유지했습니다. r2.dev 공개 접근 비활성을 확인했습니다.

## 업로드 복구와 정합성 검사

part 전송 lease는 15분입니다. 만료된 SENDING을 UNCERTAIN으로 바꾸고, 상태 조회·동일 part 재시도·cron에서 S3 ListParts로 크기·ETag를 확인합니다. 조회 lease는 30초, 실패 조회 후 대기는 5초입니다. 확인된 part만 DONE으로 복구합니다. 조회에서 부재하는 part는 아직 처리 중일 수 있어 덮어쓰지 않습니다. 취소하거나 capability 만료 후 정리합니다. S3 키가 없는 로컬에서는 이 원격 조회를 하지 않습니다.

XML은 256 KiB로 제한하며 DTD·entity 선언, 잘못된 key·upload ID, 비정상 cursor·part를 거부합니다. 완료 전 실제 목록과 DB manifest의 크기·순서·개수·ETag를 대조합니다. R2 완료 후 D1 READY 쓰기 실패는 10분 lease 만료 뒤 상태 조회·cron이 final HEAD로 복구합니다. 일시 장애는 1분 뒤 재확인하고 영구 오류 또는 2시간 복구 실패는 FAILED로 정리합니다.

cron의 reconciliation은 보고 모드입니다. `final/`·`staging/` 각각 10개를 cursor로 조사하고 READY 최대 5개의 HEAD를 확인합니다. 모든 DB 참조 key를 보호하고 알 수 없는 이름은 삭제하지 않습니다. 기본 보고는 객체 삭제·quota 수정 없이 조사 기록을 저장합니다. 일부 페이지의 결과이며 저장소 전체 총계가 아닙니다.

`POST /api/maintenance/reconcile`의 mode는 `report`, `repair_quota`, `delete_orphans`입니다. 대응하는 TOTP intent는 `maintenance_report`, `maintenance_quota`, `maintenance_delete`이며 `X-Admin-Grant`의 5분·1회용 목적별 grant와 Origin/CSRF가 필요합니다. 신뢰 기기·PIN·Bearer·capability만으로 실행할 수 없습니다. quota 수정은 두 SUM과 UPDATE를 하나의 SQLite 쓰기 문장으로 수행해 admission과 직렬화합니다.

고아 삭제는 UUID v4 서비스 key, 생성 후 24시간, 동일 version·ETag·크기·생성 시각을 24시간 이상 간격으로 두 번 관측, 최신 HEAD 일치, 삭제 직전 D1 참조 부재와 관리 lease를 요구합니다. 실행당 최대 3개입니다. DB 오류가 나면 이후 삭제를 중단합니다. R2 delete는 조건부 원자 삭제가 아니므로 DB 복원·직접 관리 쓰기와 동시 실행하지 않습니다. 복원 전 트래픽·조사·삭제를 중지하세요. 앱은 UUID key를 재사용하지 않습니다.

DELETED/released 원장은 삭제 후 30일·capability 만료·delete job 부재를 확인한 뒤 최대 50개씩 제거합니다. idempotency 행을 먼저 삭제하고 part는 FK cascade로 정리합니다. audit·보고서·일일 승인 기록은 30일 보관합니다. 참조가 있는 폐기 기기 행은 유지합니다. 대규모 실행의 원격 CPU·D1 쿼리 상한·지연 검증은 남아 있습니다.

## 관측

Worker 오류 로그는 request ID와 route template, 오류 분류만 남깁니다. Cookie, Authorization, PIN, TOTP seed·code, 사용자 파일명, signed query를 출력하지 않습니다. 정리는 `{event:"cleanup",deleted,recovered,failed}`를 출력합니다. API 응답의 request ID로 문의와 로그를 연결합니다.

Cloudflare 요청 로그가 별도로 URL·header를 수집하도록 확장될 때에는 그 수집 설정도 검토해야 합니다. 특히 서명 URL query와 인증 헤더를 별도 분석 도구에 보내지 않습니다.

출시 전 추가할 경고는 cleanup 실패·삭제 지연, 30분 이상 SENDING, 10분 이상 FINALIZING, quota 임계치, 지속 429, Worker CPU·메모리, D1 rows read/written, R2 peak storage·operations입니다. 예산 경고와 on-call 통지는 아직 구현하지 않았습니다.

## 비밀 교체

- PIN 노출: DOWNLOAD_PIN 변경과 PIN_VERSION 증가를 함께 배포하면 기존 다운로드 세션이 무효화됩니다. 이미 발급된 R2 GET URL은 짧은 TTL 동안 유효할 수 있습니다.
- TOTP seed 노출: 새로운 seed를 운영자 Authenticator에 등록하고 TOTP_SECRET_VERSION도 증가시킵니다. 기존 신뢰 기기와 공용 세션은 seed 교체만으로 폐기되지 않습니다. 공격자가 만든 credential이 의심되면 함께 폐기합니다.
- 기기 분실: 다른 기기에서 새로운 TOTP로 대상 기기를 폐기합니다. 폐기 후 새 생성·후속 capability 요청은 거부됩니다. 이미 전송 중인 R2 호출은 즉시 중단을 보장하지 않습니다.
- CSRF_SECRET 변경: 기존 CSRF 토큰이 무효화되고 UI가 상태를 다시 받아야 합니다. 사용자가 PIN을 재입력해야 하는 것은 PIN_VERSION 변경 여부로 결정합니다.
- IP_HASH_SECRET 변경: 기존 5분 제한 창의 IP 키 연결이 끊깁니다. 긴급 교체 후 global 제한과 edge 방어 상태를 확인합니다.
- IDEMPOTENCY_SECRET 변경: 기존 암호화 생성 응답 복구가 불가능해집니다. 새 생성 작업을 잠시 멈추고 최대 10분의 replay 창을 비운 뒤 교체하거나 key ring 지원을 먼저 추가합니다. 현재 코드에는 key ring이 없습니다.
- R2 key 교체: 새 bucket 한정 키로 설정을 검증한 후 기존 키를 폐기합니다. 발급된 PUT/GET URL에 미치는 영향과 진행 중 전송의 재시도를 검증합니다.

## 장애 대응과 rollback

정리 실패에는 레코드를 손으로 READY로 바꾸지 않습니다. 실패 원인을 먼저 확인하고 정상 cron이 delete job을 다시 처리하도록 합니다. D1 장애 중 R2 목록만 보고 삭제 대상을 추측하지 않습니다.

배포 실패 시 직전 Worker 버전으로 되돌리되 DB migration은 별도로 취급합니다. 이미 적용한 컬럼 추가는 남겨 호환성을 유지합니다. 이 저장소에는 destructive down migration을 넣지 않았습니다.

D1 복원은 R2를 같은 시점으로 복원하지 않습니다. 복원 후 공개 트래픽을 재개하기 전에 모든 활성 전송·credential의 재사용 가능성을 검토하고, 원장 ↔ 객체 존재·size·metadata·quota를 교차 검사합니다. 특히 과거에 폐기한 기기와 다운로드 세션이 복원으로 살아날 수 있으므로 명시적으로 다시 폐기해야 합니다. 자동 복원·재조정 스크립트는 미구현입니다.

## 확인한 기술 자료

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): 파일 스트림 처리와 binding 기반 구성.
- [Wrangler 설정](https://developers.cloudflare.com/workers/wrangler/configuration/): Worker·assets·D1·R2·cron 구성.
- [Workers Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/): Workers 런타임 테스트 구성.
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/): multipart·HEAD·get·put·abort.
- [Static assets headers](https://developers.cloudflare.com/workers/static-assets/headers/): `public/_headers`는 빌드 후 assets header 정책으로 적용합니다. Worker API 응답 헤더는 코드에서 별도로 지정합니다.
