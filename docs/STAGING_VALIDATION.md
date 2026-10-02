# 실제 Cloudflare staging 검증

2026-10-02 · v0.2.0 · 합성 시험 파일. 비밀·cookie·Bearer·signed URL은 이 보고서와 ZIP에서 제외했습니다.

## 환경

| 항목      | 값                                                                  |
| --------- | ------------------------------------------------------------------- |
| 계정      | 전용 staging 계정 (계정 정보 생략)                                  |
| Worker    | personal-temporary-drop-staging                                     |
| 주소      | https://personal-temporary-drop-staging.rmarkfcl.workers.dev        |
| D1        | temporary-drop-staging, APAC, (staging 환경 설정 참조)              |
| R2        | temporary-drop-staging, Standard, r2.dev 공개 접근 비활성           |
| 접근 제한 | API·UI·정적 자산에 X-Staging-Token 필요. secret 미설정 시에도 404   |
| 비밀      | 로컬과 분리. R2 키는 이 버킷의 Object Read & Write, 2026-11-01 만료 |
| cron      | 15분 cleanup·보고용 reconciliation                                  |
| lifecycle | staging/ 1일 만료, final/ 7일 만료·미완료 multipart 1일 중단        |

주소를 직접 열면 접근 제한으로 404가 나옵니다. 일반 UI 검증은 localhost:8787을 사용합니다. 접근 키와 R2 키는 프런트엔드 번들에 넣지 않습니다.

## 확인한 결과

- 실제 HTTPS TOTP·PIN 인증과 Secure/HttpOnly/SameSite=Strict cookie.
- 64 MiB+1 바이트, 두 part 병렬 업로드, 실제 ListParts 대조 후 READY. 다운로드 67,108,865바이트의 전체 SHA-256 일치.
- 한글 파일명의 UTF-8 attachment, part 경계 Range의 206·[0x5a,0xa5], 1초 signed GET 만료 후 실제 R2 403.
- 단축어 42바이트의 signed PUT→조건부 CopyObject→GET 일치. staging을 다시 덮어써도 final 유지.
- source ETag를 복사 직전에 변경했을 때 실제 R2 CopyObject 412 거부.
- 실제 D1 trigger로 part DONE 기록을 거부한 후 실제 ListParts로 복구.
- R2 complete 뒤 D1 READY 기록을 거부한 후 lease 만료·최종 HEAD로 READY 복구.
- DB ETag를 일부러 바꾸면 actual manifest 비교가 422, 최종 객체 HEAD는 404.
- READY expires_at을 과거로 바꾸면 새 다운로드 URL 즉시 404.
- 장애 주입 전후 quota의 원장 합계·counter 일치. 테스트 단축어 폐기 후 Bearer 403.
- gate 없는 API·UI·정적 자산 모두 404. lifecycle과 r2.dev 비공개 설정 조회.
- 2026-10-02 18:45 KST 정기 cron에서 만료·실패 시험 파일을 DELETED/released로 정리했습니다. 두 final 객체 HEAD 404, reserved 0, ready 134,217,814바이트와 원장 합계 일치. 자동 보고서의 누락·크기 불일치 0.

64 MiB+1 SHA-256: `db06a3cba93535048b096474d502e91c737410edda4ff81abcfc93e82cc922e9`. 기록된 한 실행의 전송·확정은 17.4초이며 성능 보장 값이 아닙니다. 42바이트 단축어 SHA-256: `51641f7535f83c8352c52f404bf7dc9fd4afbd07b205f12e2f3cf2c8b342cbba`.

`STAGING_SMOKE_RESULT.json`과 `STAGING_FAULT_RESULT.json`에 시간·파일 ID·개별 결과를 저장했습니다. 장애 주입 trigger는 시험 파일 ID에 한정하고 마지막에 제거했습니다. fault 세션과 smoke 단축어 credential도 폐기했습니다. 정상 smoke 파일의 retention은 1시간입니다.

`STAGING_FINAL_RESULT.json`은 최신 UI 자산 gate·물리 삭제·quota 해제·자동 보고·시험 trigger 제거의 최종 확인입니다. Worker 배포 버전은 `d546a70c-13dc-4d85-9f91-184bae015e35`입니다. 마지막 DB 조회의 일회성 7403 응답은 같은 로그인으로 재확인했을 때 정상 조회됐습니다.

## 재실행과 범위

```powershell
node scripts/smoke-staging.mjs <private-staging-secrets.json>
```

현재 계정의 비밀 JSON을 저장소 밖에서 지정합니다. 스크립트는 시험 파일과 단축어 credential을 만들며 마지막에 credential을 폐기합니다. TOTP 창을 기다리며, 짧은 시간에 반복하면 rate limit에 걸릴 수 있습니다. 비밀과 signed query를 출력하지 않습니다.

원격 migration은 SQL LF 고정·trigger SELECT CASE 괄호 처리 후 0001–0003 적용을 확인했습니다. Windows에서 발견된 서버 SQL splitter 오류를 해결한 동일 의미의 SQL입니다.

실제 24시간 간격 orphan 관측·삭제, 다량 paging·cron, 원격 삭제 장애, CPU·메모리·과금 분석, 1/5/16/32 GiB, Safari·iOS, D1 복원·production은 미완료입니다. orphan grace·DB 장애 시 중단·quota 수정·오프라인은 자동 테스트로 검증했습니다.

API 의미는 [R2 S3 호환성](https://developers.cloudflare.com/r2/api/s3/api/), [R2 인증](https://developers.cloudflare.com/r2/api/tokens/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)를 확인했습니다.
