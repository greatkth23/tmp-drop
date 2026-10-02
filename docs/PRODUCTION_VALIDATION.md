# 운영 배포와 실제 웹사이트 검증

2026-10-03 KST · 구현 v0.2.0 · 시험에는 합성 파일만 사용했습니다.

## 배포

| 항목           | 값                                                                |
| -------------- | ----------------------------------------------------------------- |
| 주소           | https://drop.rmarkfcl.workers.dev                                 |
| Worker         | `drop`, production, workers.dev 활성, preview URL 비활성          |
| 현재 배포 버전 | `26f67d57-7ced-4d14-ba55-5ea0d2d7ef4d`                            |
| D1             | `temporary-drop-production`, APAC, migration 0001–0003            |
| R2             | `temporary-drop-production`, r2.dev 공개 접근 비활성              |
| 서명 키        | 해당 버킷만 Object Read & Write, 이름 `tmp-drop-production-s3`    |
| 비밀           | Worker secrets 7개, local/staging과 분리                          |
| 정리           | 15분 cron; final 7일, staging 2일, 미완료 multipart 1일 lifecycle |

인증 전 UI는 열 수 있지만 목록은 PIN, 업로드는 TOTP, 기기 관리는 별도 재인증을 요구합니다. 운영 Authenticator 등록과 PIN 안내는 저장소 밖 `%USERPROFILE%\.codex\private\tmp-drop\production-access.html`에 있습니다. 비밀과 signed URL은 이 문서·증거 JSON·Git에서 제외했습니다.

## 실제 Chrome 검증

- 처음 접근한 다운로드 화면에서 목록이 숨겨지고 PIN 입력 화면이 나옵니다. PIN 기억과 신뢰 기기는 기본 OFF입니다.
- TOTP 인증 후 파일 선택으로 100바이트 한글 텍스트와 1 MiB 바이너리를 추가하고, 1시간 보관을 선택해 두 파일을 업로드했습니다.
- PIN 인증 후 목록에서 각각 다운로드 버튼을 눌러 실제 Downloads 폴더에 받은 파일의 크기와 SHA-256을 원본과 대조했습니다.
- 64 MiB+1바이트 파일도 브라우저에서 두 part로 전송해 완료했고, 다운로드한 67,108,865바이트의 SHA-256이 일치했습니다. 같은 객체를 독립 API 검사에 사용했습니다.
- 다운로드 잠금, 관리 재인증 화면, 320/390px 수평 overflow 없음, 종료 dialog의 Escape와 트리거로의 포커스 복귀를 확인했습니다.
- 보관 기간을 바꿔도 옆 안내가 24시간에 고정돼 있던 문제를 수정하고 재배포한 화면에서 1시간으로 함께 바뀌는 것을 확인했습니다.

| 파일                 |     바이트 | 다운로드 SHA-256                                                   |
| -------------------- | ---------: | ------------------------------------------------------------------ |
| 브라우저-검증.txt    |        100 | `d88b196d70a3aedd068108913decbbf7fce84aaea4cd335211e2939a4e4f92ef` |
| 브라우저-검증.bin    |  1,048,576 | `16c7f1d8a38b4b84560e558ab03b13c82e2ff374d87eaacb4df22f03604e7a4f` |
| 브라우저-64MiB+1.bin | 67,108,865 | `db06a3cba93535048b096474d502e91c737410edda4ff81abcfc93e82cc922e9` |

현재 원본과 캡처는 로컬 `.wrangler/verification`에 있고 파일 대조 결과는 `PRODUCTION_BROWSER_RESULT.json`에 있습니다. Chrome의 다운로드 이벤트 대기는 시간 초과했으나 실제 다운로드 파일 생성과 전체 해시로 결과를 확인했습니다.

## 운영 API와 정리 검증

- UI 3개 경로 200, 인증 전 목록·새 업로드 거부, 로컬 정리 API와 잘못된 API 경로 404.
- TOTP/PIN 및 Secure·HttpOnly·SameSite=Strict 발급 cookie.
- 실제 signed GET의 전체 SHA-256·한글 attachment, part 경계의 Range 206, 1초 signed URL 만료 후 R2 403.
- 42바이트 단축어 signed PUT → 조건부 CopyObject → GET 해시 일치. staging 덮어쓰기 후에도 final 유지.
- source ETag 변경 시 실제 CopyObject 412.
- 정합성 보고에서 READY 객체 누락·크기 불일치 0, quota counter와 파일 원장 합계 일치.
- 시험 단축어 토큰을 폐기한 뒤 후속 Bearer 업로드 403. 시험 업로드·다운로드 세션 종료.
- Node 업로드가 중단된 시험 파일 ID 2개만 취소 요청 상태로 전환했습니다. 실제 **00:30 KST cron**에서 두 파일이 `DELETED/released`가 됐고 예약 용량이 0으로 해제됐습니다. 같은 cron이 생성한 정합성 보고의 객체 누락은 0입니다.

전체 API smoke는 종료 코드 0으로 완료했으며 `PRODUCTION_SMOKE_RESULT.json`에 각 검사를 기록했습니다. `PRODUCTION_FINAL_RESULT.json`은 취소 시험 파일의 R2 HEAD·물리 정리·quota와 자동 보고 증거입니다.

## 재배포와 재검증

```powershell
npm run config:production
npm run check
npm run deploy:check
npm run deploy:production
```

개인 비밀 JSON과 해당 환경의 Wrangler config를 지정합니다. 증거 파일 위치도 인자로 지정할 수 있습니다.

```powershell
node scripts/smoke-staging.mjs <private-secrets.json> wrangler.production.jsonc <result.json>
```

이 PC에서 Node의 64 MiB PUT은 첫 번째 part가 Worker에 도착하기 전에 시간 초과했고, Node HTTPS 경로에서도 완료되지 않았습니다. 원인은 확정하지 않았습니다. 실제 Chrome 업로드·다운로드는 성공했습니다. 브라우저로 이미 완료한 위 패턴의 64 MiB+1 합성 객체를 독립 다운로드·Range·단축어 검사에 재사용하려면 마지막 인자로 그 파일 ID를 지정합니다. 브라우저 전송을 Node PUT 성공으로 기록하지 않습니다.

```powershell
node scripts/smoke-staging.mjs <private-secrets.json> wrangler.production.jsonc <result.json> <browser-fixture-file-id>
```

TOTP는 동일 코드를 재사용할 수 없고 5분에 5회까지 인증할 수 있습니다. 브라우저 테스트와 smoke 반복 사이에는 충분한 간격을 둡니다. 시험 파일은 선택한 보관 기간 후 정리됩니다. D1 원장에는 삭제 증거가 30일 남을 수 있습니다.

## 검증 범위

타입·포맷·Workers 테스트 41개·UI 빌드·로컬 및 운영 dry-run을 통과했습니다. GitHub의 Validate application workflow는 push마다 같은 검사와 dry-run을 수행합니다.

이 결과는 Chrome·64 MiB+1까지의 실제 개인 파일 전송 검증입니다. iPhone/Safari, 설치 가능한 `.shortcut`, 1/5/16/32 GiB, 장시간 회선 단절, D1 복원, 대규모 cron/orphan paging, 알림과 예산 설정은 남아 있습니다. 웹 32 GiB·단축어 5 GiB는 정책 상한이며 실측 최대 크기로 표시하지 않습니다.

## 즉시 삭제 기능 검증 — 2026-10-03

배포 `baea299b-c77a-4ba9-9a4b-9c6a999c83b7`. 완료된 파일 목록에 삭제 버튼을 추가했습니다. PIN으로 목록을 연 뒤 확인창에서 새 TOTP 코드를 입력하면 해당 파일에 묶인 1회 grant로 영구 삭제합니다. 삭제 중에는 다운로드를 차단하며 R2 final/staging 삭제가 끝난 뒤 용량을 반환합니다. 저장소 장애는 삭제 임대와 cron 재시도로 복구합니다.

`npm run deploy:production`의 typecheck, format, 테스트 45개, build가 통과했습니다. 추가 테스트 4개는 대상별 TOTP grant, PIN 단독·다른 목적/대상·Origin/CSRF·잠긴 세션 거부, 즉시 final/staging 삭제·중복 용량 반환 방지·grant 재사용 차단, R2 장애 후 cron 복구를 검증합니다.

운영에서는 별도로 올린 48바이트 `delete-test-disposable.txt`만 삭제했습니다. 목록에서 사라지고 Worker 다운로드, 삭제 전 signed URL, R2 HEAD가 모두 404였습니다. D1은 DELETED/released, 해당 파일의 정리 작업은 0건이며 용량 counter가 실제 ready ledger와 일치했습니다. Chrome 데스크톱 및 390px 모바일에서 버튼·확인창·취소 후 파일 유지와 가로 넘침 없음을 확인했습니다. 실제 삭제는 API로 검증했고 브라우저에서는 확인창과 취소를 검증했습니다. 상세 결과: `PRODUCTION_DELETE_RESULT.json`.

## 신뢰 기기 삭제 인증 생략 — 2026-10-03

배포 `0f17c5b0-98db-41be-986f-8747cd091e3c`. 유효한 신뢰 브라우저는 다운로드 잠금을 연 뒤 확인창만으로 삭제할 수 있습니다. 서버가 browser cookie의 등록·종류·revoked_at을 검사하며 공용 세션, 위조 cookie, 등록 해제된 기기, 단축어는 TOTP 예외를 받지 않습니다. Origin, CSRF, 다운로드 세션 검사는 유지합니다.

배포 전 typecheck, format, 테스트 51개, build가 통과했습니다. 추가 테스트 6개는 신뢰 브라우저의 grant 없는 삭제·중복 용량 반환 방지, Origin/CSRF/잠금 검사, 등록 해제·위조·단축어·만료 공용 세션의 인증 생략 거부를 검증합니다.

운영에서는 별도 48바이트 `trusted-delete-test.txt`를 생성했습니다. 공용 업로드 세션의 grant 없는 삭제는 403, 테스트 신뢰 브라우저의 같은 요청은 DELETED였고 R2 HEAD 및 다운로드는 404였습니다. 테스트 기기는 검증 직후 등록 해제했고 같은 cookie의 삭제 요청이 다시 403이 됐습니다. Chrome의 기존 신뢰 브라우저에서 확인창에 Authenticator 입력란이 없고 영구 삭제 버튼만 표시됨을 확인했으며 취소 후 파일이 유지됐습니다. 실제 삭제는 API로 검증했습니다. 상세 결과: `PRODUCTION_TRUSTED_DELETE_RESULT.json`.
