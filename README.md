# Personal Temporary Drop

개인 기기와 임시 PC 사이에서 파일을 전달하는 서비스의 v0.2.0 구현입니다. React UI, Cloudflare Worker API, D1 원장, R2 전송·정리 로직을 연결했습니다. **로컬과 보호된 실제 Cloudflare staging에서 검증했으며, 실기기·대용량·운영 출시 검증은 남아 있습니다.**

## 실행

Node.js 24 이상이 필요합니다. 이 프로젝트 폴더에서 실행합니다.

```powershell
npm ci
npm run setup:local
npm run types
npm run db:local
npm run build
npm run dev
```

브라우저에서 <http://localhost:8787>을 엽니다. localhost와 127.0.0.1은 쿠키가 분리되므로 한 주소를 계속 사용하세요. 기본 주소는 localhost입니다. 로컬 설정으로 외부 호스트에 접근하는 API 요청은 거부됩니다.

다른 터미널에서 개발용 인증 코드를 확인합니다.

```powershell
npm run code
```

다운로드에는 출력된 PIN을, 업로드에는 현재 Authenticator 코드를 입력합니다. TOTP 코드는 30초마다 바뀌며 동일 시간 단계의 코드를 두 번 사용할 수 없습니다. 관리 작업에는 다음 코드가 필요할 수 있습니다. 신뢰 기기와 PIN 기억 체크는 기본 OFF입니다.

`setup:local`은 임의의 개발용 비밀을 생성하며 기존 값을 보존합니다. `.dev.vars`와 `local-access.json`에는 개발용 비밀이 있으므로 공유하거나 운영에 재사용하지 마세요. Windows의 파일 접근 권한은 사용자의 디렉터리 ACL을 따릅니다. Unix mode 옵션이 Windows ACL을 제한하는 것은 아닙니다.

UI 개발 중에는 Worker를 켠 상태에서 `npm run dev:ui`를 실행할 수 있습니다. Vite가 `/api` 요청을 로컬 Worker로 전달합니다. 최종 통합 확인은 빌드한 UI와 Worker가 함께 있는 8787에서 수행합니다.

로컬 Wrangler는 cron을 시간에 맞춰 자동 실행하지 않습니다. 로컬 정리를 시험하려면 `http://localhost:8787/cdn-cgi/local/scheduled?format=json`을 요청하거나 인증 후 `/api/local/cleanup`을 사용하세요. 운영 cron은 배포 설정의 15분 주기를 사용합니다.

## 구현한 흐름

- `/`: PIN 인증, 2시간 또는 30일 다운로드 세션, 미만료 READY 목록, 다운로드와 잠금.
- `/upload`: TOTP, 900초 공용 세션, 신뢰 브라우저 등록, 파일 선택·드롭, 보관 시간, 대기열·진행률·취소.
- `/devices`: 기기 목록, 목적·대상에 묶인 TOTP 재인증, 기기 폐기, 업로드 전용 단축어 토큰의 1회 표시.
- 64 MiB multipart 전송. 탭 전체 part 동시 수는 데스크톱 4, 좁은 화면 2입니다. 동시에 진행하는 파일은 2개입니다.
- 자연 만료된 공용 세션에서도 발급된 파일별 권한으로 기존 전송을 이어갑니다. 명시적 기기 폐기·세션 종료는 후속 요청을 차단합니다.
- 서버가 만든 part manifest와 최종 HEAD의 크기를 검증한 후 공개합니다. 보관 시간은 최초 완료 시점부터 계산합니다.
- 100 GiB 논리 용량, 200 GiB 일일 생성 승인량, 전체 8개·주체별 4개 활성 업로드를 D1 admission 트랜잭션으로 제한합니다.
- 만료·취소·실패 파일 정리, 완료 중 장애 복구, 삭제 lease·재시도, quota 1회 해제, staging 재정리.
- R2 ListParts로 불확실한 part 복구, 전송 lease, 실제 R2 manifest 교차 검사. 미확인 part를 덮어쓰지 않습니다.
- 오프라인 대기와 재연결 후 서버 확인. 이미 수신된 part를 재전송하지 않습니다.
- cursor 기반 고아 객체 조사, READY 객체 HEAD 검사, quota 교차 검사와 목적별 TOTP 관리 작업.

파일 크기 상한은 웹 32 GiB, 단축어 5 GiB로 설정되어 있습니다. 이 값은 **검증한 최대 크기**를 의미하지 않습니다. 현재 실제 전송 확인은 64 MiB + 1바이트까지입니다.

## 검증

```powershell
npm run check
npm run deploy:check
```

타입 검사, 포맷 검사, Workers 런타임의 41개 통합·스트림·업로더 테스트, UI 빌드를 수행합니다. `deploy:check`는 원격 배포를 하지 않는 번들 검사입니다.

Worker를 켠 상태에서 실제 HTTP multipart·다운로드 검증을 다시 수행하려면:

```powershell
npm run smoke:local
```

64 MiB + 1바이트의 합성 파일을 두 part로 병렬 전송하고 전체 SHA-256과 part 경계를 가로지르는 Range를 검사합니다. 1시간 후 만료되는 검증 파일이 로컬 목록에 남습니다. 방금 UI에서 사용한 코드와 같은 시간 단계이면 CODE_ALREADY_USED가 발생하므로 다음 30초 단계에서 실행합니다.

## 구조

| 경로                            | 역할                                                  |
| ------------------------------- | ----------------------------------------------------- |
| `src/`                          | React 화면, API 클라이언트, 메모리 기반 업로더        |
| `shared/contracts.ts`           | 입력 스키마, DTO, 정책 기본값, 파일명 처리            |
| `worker/`                       | Hono API, 인증, 암호화, R2 스트림·서명·확정, 정리     |
| `migrations/`                   | D1 테이블·CHECK·인덱스·admission 및 quota 트리거      |
| `tests/`                        | Cloudflare Workers 런타임 통합 테스트                 |
| `scripts/`                      | 로컬 인증 생성, 코드 조회, HTTP smoke, 운영 설정 검사 |
| `docs/API.md`                   | 현재 API 계약                                         |
| `docs/OPERATIONS.md`            | 운영 준비·비밀 교체·장애 대응                         |
| `docs/IMPLEMENTATION_STATUS.md` | 계획 대비 구현·검증·미완료 구분                       |
| `docs/SHORTCUT.md`              | 단축어 API 연결 절차와 실기기 검증 항목               |

`worker/env.d.ts`는 `npm run types`로 생성합니다. 배포 환경 변수를 수작업으로 정의하지 않습니다. 테스트용 TOTP·PIN은 공개 fixture이며 운영 비밀과 무관합니다.

## 현재 제한

R2에 part가 저장되었는데 응답 또는 D1 기록이 불확실하면 ListParts로 수신 여부·크기·ETag를 확인해 복구합니다. 원격 S3 키가 없는 로컬에서는 불확실한 part를 조회할 수 없으며, 확인될 때까지 대기하거나 취소·만료 처리합니다. R2가 아직 확인하지 않은 part를 재전송하는 복구는 제공하지 않습니다. DB lease는 R2 호출을 중단시키는 장치가 아닙니다.

브라우저 새로고침·재시작 후 업로드 복구, iOS 백그라운드 전송, 실제 `.shortcut` 설치 파일은 제공하지 않습니다. iPhone 경로는 API와 안내를 구현했으며 실기기 시험이 필요합니다. Cloudflare limits·비용, 1/5/16/32 GiB 전송, 대규모 정리·복원 검증은 출시 전 남은 작업입니다.

staging Worker·D1·비공개 R2와 lifecycle 설정을 만들고 배포했습니다. 모든 staging 페이지·API는 별도 `X-Staging-Token`을 요구합니다. 로컬 비밀과 staging 비밀은 서로 다릅니다. 직접 주소를 열어 404가 나오는 것은 접근 제한의 정상 동작입니다. 운영 배포와 GitHub CI 실행은 아직 수행하지 않았습니다. 증거와 남은 항목은 `docs/STAGING_VALIDATION.md`와 `docs/IMPLEMENTATION_STATUS.md`를 확인하세요.
