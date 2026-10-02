# 계획 대비 구현 현황

기준일 2026-10-03 · 구현 v0.2.0. Windows/Node 24, 로컬 Workers·D1·R2, 보호된 staging 및 별도 운영 환경에서 검증했습니다. Safari·iPhone·GiB 단위 전송의 결과로 일반화하지 않습니다.

## 운영 배포와 실제 사이트 검증

- `https://drop.rmarkfcl.workers.dev`에 운영 Worker를 배포했습니다. D1·비공개 R2·서명 키·TOTP·PIN은 staging과 분리했습니다.
- 실제 Chrome에서 100바이트·1 MiB·64 MiB+1 파일을 선택·업로드·다운로드했고 SHA-256이 일치했습니다.
- 운영 API의 인증 경계, signed GET·Range·만료, 단축어 signed PUT·조건부 CopyObject·기기 폐기, 원장과 quota 일치를 확인했습니다.
- 실제 2026-10-03 00:30 KST cron에서 취소 요청한 시험 업로드 2개가 DELETED로 정리됐고 자동 보고의 READY 객체 누락은 0입니다.
- 320/390px Chrome 화면의 수평 overflow, 기본 신뢰/기억 OFF, 관리 재인증 화면, 종료 대화상자의 Escape와 포커스 복귀를 확인했습니다.
- 보관 기간 선택과 옆 안내를 동기화했고 LF 줄바꿈을 고정해 Windows와 CI의 포맷 검사를 정리했습니다. 운영 설정 검사와 원격 smoke의 경로를 현재 저장소 구조에 맞췄습니다.
- 운영 Authenticator 등록 도구와 비공개 HTML을 추가했습니다. 원격 smoke의 64 MiB Node 업로드는 이 PC에서 시간 초과가 있었으므로, 실제 브라우저 업로드를 독립 API 다운로드 검증에 재사용했습니다.

세부 증거는 `PRODUCTION_VALIDATION.md`, `PRODUCTION_SMOKE_RESULT.json`에 있습니다.

## 이번 구현

- S3 ListParts 어댑터, bounded XML 검증과 페이지 처리, 실제 multipart manifest 교차 검사.
- part 15분 lease와 UNCERTAIN 재조정. 저장소가 확인한 part만 복구하며 불확실한 part를 덮어쓰지 않습니다.
- R2 완료 뒤 D1 READY 쓰기 실패의 HEAD 기반 복구. 만료 lease는 상태 조회와 cron에서 처리합니다.
- complete/cancel 경합에서 취소가 성공한 것처럼 응답하지 않도록 CAS 결과 검사.
- 오프라인 대기, 재연결 후 서버 상태 확인, 이미 저장된 part의 중복 전송 방지.
- orphan cursor·24시간 grace·두 관측·최신 참조 검사, READY 객체 HEAD와 quota 교차 검사.
- 보고·quota 수정·고아 삭제의 목적별 일회용 TOTP 관리 권한.
- 보고서·일일 기록·DELETED 원장의 30일 보관과 작은 배치 purge.
- 독립 staging Worker·D1·R2, 별도 비밀, 전체 경로 접근 gate, 비공개 버킷과 lifecycle 규칙.
- Windows 원격 D1 trigger 파싱 문제 해결: SQL LF 고정, CASE 표현식 괄호 처리. 기존 로컬 schema 의미는 동일합니다.

## 검증한 결과

- 41개 자동 테스트 통과: 기존 24개와 업로드 복구·저장소 응답 검증·D1 장애·취소 경합·quota·orphan·staging gate·오프라인 테스트 17개.
- 타입·포맷·UI 빌드·Wrangler dry-run 통과. 프런트엔드 테스트는 DOM 타입, Worker 테스트는 Workers 타입으로 분리합니다.
- 로컬과 실제 staging에서 67,108,865바이트를 두 part로 병렬 전송. 다운로드 SHA-256 `db06a3cba93535048b096474d502e91c737410edda4ff81abcfc93e82cc922e9` 일치, 부분 경계를 가로지르는 Range 통과.
- 실제 R2 signed PUT·CopyObject·GET, 한글 attachment, 만료된 signed URL 거부, 원본 ETag 변경 시 CopyObject 412, staging 덮어쓰기 후 final 불변성 통과.
- 실제 D1 trigger로 part acknowledgement와 READY 쓰기를 각각 거부해 복구 확인. 실제 ListParts의 ETag 불일치 시 CompleteMultipartUpload 전에 거부했습니다.
- 원격 TOTP·PIN과 Secure/HttpOnly/SameSite=Strict cookie 확인. 테스트 단축어 credential을 생성한 뒤 폐기했고 후속 Bearer 요청은 403으로 거부됐습니다.
- API·페이지·정적 자산 모두 staging gate 없이는 404. R2 r2.dev 공개 접근 비활성, lifecycle 설정 조회 확인.
- 실제 18:45 KST cron에서 만료·실패 파일의 물리 삭제와 quota 해제 확인. 자동 정합성 보고서에서 객체 누락·크기 불일치 0.
- 로컬/원격 DB에 migration 0001–0003 적용. 로컬 인증 정보는 보존했고 staging 비밀은 새로 생성했습니다.
- 기존 브라우저 검증: 59바이트 파일 UI 업로드/다운로드 SHA-256 일치, 900초 인증 만료, 320/390/768px 화면 검사. v0.2 오프라인 재연결은 모의 연결 이벤트 자동 테스트입니다.

원격 검증의 시간·파일 ID·SHA-256과 범위는 `STAGING_VALIDATION.md` 및 JSON 증거를 참고하세요. 현재 설정 상한인 웹 32 GiB·단축어 5 GiB를 실제 검증한 크기로 표시하지 않습니다.

## 계획별 상태

| 계획 ID           | 현재 상태                                                                         | 남은 조건                                                                |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| I01–I04 / I08     | 로컬 실행, staging/production 분리·원격 schema·배포, Git 원격 연결·CI 파일        | D1 복원 drill                                                            |
| I05               | shared schema·DTO·API 문서                                                        | OpenAPI 생성                                                             |
| I06 / I07         | R2 어댑터·서명·실제 CopyObject·ListParts 검증                                     | 원격 로그 수집·민감 정보 수집 설정 audit                                 |
| A01–A10           | scope·Origin/CSRF·TOTP replay·rate limit·기기·관리 grant, 원격 cookie/폐기        | RFC 시간 벡터·대규모 기기 목록·시간 경계 추가 시험                       |
| U01–U10           | admission·capability·stream·manifest·완료·취소·queue·ListParts 복구·lease·offline | 1/16/32 GiB, 장시간·실제 회선 단절·다수 동시 업로드·complete/cancel 부하 |
| U11 / A10         | 단축어 API·실제 signed PUT·조건부 복사·source race                                | iOS foreground·실기기·5 GiB                                              |
| U12 / F08         | 연결 안내·토큰 1회 표시                                                           | 실제 `.shortcut` 생성·설치·서명·기기별 사용 검증                         |
| D01 / D02         | cursor·TTL·download·Range와 원격 signed GET·한글 attachment                       | 대용량·실기기·장시간 만료 재접속                                         |
| L01 / L02         | 삭제 lease·재시도·정확한 quota 해제, 실제 lifecycle                               | 삭제 중 DB/R2 장애, 다량 동시 cron과 원격 지연 측정                      |
| L03 / L04         | 자동 보고·orphan paging/grace·quota 교차/수정, 별도 TOTP 삭제                     | 실제 24시간 grace 관측, 대규모 R2 paging, D1 복원과 정합성 drill         |
| F01–F10           | 세 화면·gate·queue·기기·dialog·모바일 CSS·offline                                 | Safari/iPhone/iPad, VoiceOver·키보드 전체 흐름·대비 audit                |
| O01–O06 / S01–S08 | 로컬 bootstrap, staging/production 검증, 운영 TOTP 등록, 비밀 교체·장애 문서      | 경고·예산·복원, 대용량 CPU/메모리/비용, 확대 검증                        |

## 다음 순서

1. iPhone/iPad foreground에서 단축어 API를 시험하고 실제 설치 파일·사용 안내를 만듭니다. 실기기를 통한 사용자 검증이 필요합니다.
2. 1/5/16/32 GiB의 SHA-256, CPU·메모리·시간·R2/D1 작업량을 측정합니다. 회선 단절·delete 장애·다중 cron·cursor 부하를 함께 검사합니다.
3. 예산/장애 경고, D1 복원 drill, 접근성 전체 audit와 운영 확대 검증을 진행합니다.

v0.2의 기본 파일 전송은 운영 배포와 실제 웹사이트 검증까지 완료했습니다. 실기기·GiB 단위 전송·복원·경고와 예산 등 운영 v1의 확대 검증은 남아 있습니다.
