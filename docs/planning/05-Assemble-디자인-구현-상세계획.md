# Temporary Drop — Assemble 디자인 구현 상세계획

작성일: 2026-10-03 KST · 버전: 1.0 · 상태: 구현 착수용 계획

제품 요구사항: [프런트엔드 전면 리디자인 PRD](04-프런트엔드-전면-리디자인-PRD.md)

## 1. 구현 목표와 디자인 기준

사용자가 제공한 **Assemble Design System v1.0**을 Temporary Drop의 받기·올리기·기기 관리에 적용한다. 밝은 회백색, 검정 타이포그래피, 제한적인 lime, 20px 곡면, pill 버튼, 여백 중심의 구획을 공통 시각 언어로 사용한다.

작업의 기준은 다음과 같다.

1. 제품 기능·권한·시간 정책은 최신 PRD와 현재 API를 따른다. 완료 파일의 개별 삭제를 포함한다.
2. 시각 스타일은 사용자 첨부 시스템을 기준으로 한다. 원본 사이트의 관측값이 첨부값과 달라도 자동으로 바꾸지 않는다.
3. 접근성·한국어 가독성·짧은 전송 작업을 위해 보완하는 값은 아래 적용표에 명시한다.
4. 현재 React·TypeScript·Vite와 CSS로 구현한다. Tailwind, 라우터, UI 프레임워크를 새 디자인의 필수 의존성으로 추가하지 않는다.

이 문서는 구현 계획이다. 작성 단계에서는 실제 제품 UI·전송 엔진·Worker를 변경하지 않는다. 구현 기본안은 PRD의 **A. 전송 데스크**로 구체화하되, B/C 구조 비교도 같은 Assemble 시각 체계로 수행한다. 최종 구조를 선택한 뒤 화면 구현을 진행한다.

### 원본 참고 범위와 확인 결과

2026-10-03에 [Onassemble 홈페이지](https://www.onassemble.com/)의 첫 화면과 스크롤 구간을 브라우저로 확인했다. 큰 검정 제목, pill CTA, 작은 lime 강조, 여백과 곡면으로 나눈 면, 스크롤 시 floating navigation을 참고했다. DOM의 첫 화면 제목은 Anthro Trial 계열 64px/64px였고 보조 제목은 23px였다.

이는 공개 홈페이지 관측이며 Assemble의 로그인 후 앱 디자인을 확인한 결과가 아니다. 사용자 첨부 시스템도 원시 Dembrandt 출력이 아니라 이미 정규화된 제안이다. 원본을 재추출해 전체 토큰의 동일성을 검증했다고 주장하지 않는다.

원본의 영문 문구·로고·고객 로고·3D 소품·서비스 이미지는 Temporary Drop에 복사하지 않는다. 폰트 파일도 원본 사이트에서 가져오지 않는다. 원본의 마케팅 섹션 간격과 반복 floating 메뉴는 파일 작업에 맞는 값으로 조정한다.

## 2. 기존 코드와 변경 경계

| 현재 파일 | 확인한 책임 | 계획한 변경 |
| --- | --- | --- |
| [src/App.tsx](../../src/App.tsx) | 경로·인증 시계·전역 dialog·세 페이지·인증 폼·파일 행 | 셸·공통 입력/dialog·페이지·상태 hook으로 점진 분리 |
| [src/styles.css](../../src/styles.css) | 녹색 토큰·현재 grid/행·719/959px 반응형 | Assemble 토큰·새 셸·공통 상태·729/999px UI 규칙으로 교체 |
| [src/main.tsx](../../src/main.tsx) | App mount와 CSS import | 최종 CSS 진입점 유지, 필요 시 스타일 파일 import만 조정 |
| [src/api.ts](../../src/api.ts) | CSRF·쿠키 요청·ApiFailure·authStatus | 기존 요청 계약 유지, 화면에 오류 코드를 전달하는 adapter 추가 |
| [src/uploader.ts](../../src/uploader.ts) | singleton 엔진·메모리 queue·전송·취소·재시도 | 승인 전 대기 분리, 확인 지연/오류 코드/결과 재조회 최소 계약 보완 |
| [shared/contracts.ts](../../shared/contracts.ts) | 보관/크기 정책·DTO·TOTP intent | UI를 위한 중복 정책 생성 금지. API 계약 변경이 필요할 때만 수정 |
| [worker/index.ts](../../worker/index.ts) | PIN/TOTP·logout·기기·삭제·목록·다운로드 API | 현재 API를 사용. 디자인만을 위한 권한 완화·새 endpoint 추가 없음 |
| [tests/uploader.test.ts](../../tests/uploader.test.ts) · [tests/api.test.ts](../../tests/api.test.ts) | 업로더와 Worker 통합 회귀 | 변경하는 엔진 동작의 의미 있는 회귀 추가, 기존 삭제 권한 시험 재사용 |

현재 화면은 인증 상태 조회 실패 시 `fatal` 분기로 전체 main을 대체한다. 새 구조는 최초 진입 오류와 사용 중 갱신 오류를 구분하여 진행 목록을 계속 보여준다. 접근 권한이 불확실하면 새 민감 요청은 보류하고 인증 상태를 재확인한다.

기존 `QueueView`는 오류 문자열만 전달한다. ‘서버 확인 지연’과 ‘새로 시작 가능한 실패’를 정확히 나누려면 시각 변경에 더해 엔진 계약 조정이 필요하다. 이 변경은 단계 D05에서 별도로 검증한다.

## 3. 첨부 시스템 적용표

| 항목 | 적용 결정 | 구현 이유 |
| --- | --- | --- |
| 배경 `#F8F8F8`, surface white, 검정 본문 | 그대로 사용 | 첨부 시스템의 기본 인상 유지 |
| lime `#F1FD82` | 그대로 사용, 한 화면의 주 시작 행동 또는 선택 상태 중심 | 반복적인 성공/경고색과 구분 |
| 보조 텍스트 `#757575` | 흰 면에서는 유지, 바탕 위에는 `#707070` | 작은 텍스트 대비 보완 |
| `#CFCFCF` border | 장식 구분선에 유지, 입력 식별 경계는 `#757575` | 구분선과 필요한 control 경계의 역할 분리 |
| Anthro/Inter | 사용 권한이 확보된 로컬 파일만 적용, 없으면 시스템 fallback | 사이트의 Trial 파일을 제품 자산으로 사용하지 않음 |
| 64/45/32/24/16/14/12px type scale | 유지, 한국어 줄 높이 조정 | 영문 display의 짧은 line-height를 한국어 본문에 적용하지 않음 |
| 4px spacing grid | 그대로 사용 | UI 여백을 한 체계로 관리 |
| 160–240px hero, 96–160px section spacing | 토큰은 보존, 작업 화면에는 사용하지 않음 | 핵심 목록과 행동이 과도하게 아래로 밀리지 않게 함 |
| 카드 20px·pill 999px·circle 50% | 그대로 사용 | 일반 카드는 그림자 없이 면과 여백으로 구획 |
| input border 없음·focus 1px 검정 | input 식별 경계와 2px 검정 focus로 보완 | white-on-white 입력 식별, 키보드 위치 가시성 |
| 일반 링크 inherit/no underline | nav/button에는 적용, 문장 속 도움말 링크는 underline | 텍스트 안에서 링크를 색만으로 구분하지 않음 |
| 160–240ms motion | 160ms/200ms 기본값, reduced-motion 대응 | 짧은 상태 피드백, 반복 장식 애니메이션 제거 |
| 999/729px breakpoint | UI에 그대로 적용 | 1000px 이상 desktop, 730–999px tablet, 729px 이하 mobile |
| semantic 성공/주의/실패색 | 제품 확장 토큰 3쌍 추가 | 첨부 시스템에 없는 전송·삭제·인증 실패 표현 필요 |

6px compound CTA 내부 inset은 첨부에서 설명한 특수 구성값이다. 공용 spacing scale에는 추가하지 않고 `button-icon-inset` 하나로 한정한다. 1px border·2px focus는 spacing token이 아니다. `98px` breakpoint, 기본 파란 링크, 의미 없는 검정 변형은 도입하지 않는다.

### 대비 검증 기록

불투명한 sRGB foreground/background의 상대 휘도로 계산했다. hover·focus·실제 인접색 조합은 구현 후 별도로 검사한다.

| 조합 | 계산 대비 | 사용 판단 |
| --- | --- | --- |
| `#757575` / `#FFFFFF` | 4.61:1 | 흰 카드의 일반 보조 텍스트 가능 |
| `#757575` / `#F8F8F8` | 4.34:1 | 작은 텍스트에는 사용하지 않음 |
| `#707070` / `#F8F8F8` | 4.66:1 | 바탕 위 보조 텍스트 |
| `#CFCFCF` / `#FFFFFF` | 1.56:1 | 입력 식별의 유일한 경계로 사용하지 않음 |
| `#111111` / `#F1FD82` | 17.19:1 | lime CTA/선택 상태 텍스트 |
| `#B42318` / `#FFF1F0` | 5.98:1 | 실패/삭제 오류 |
| `#24633C` / `#EFF7F0` | 6.58:1 | 완료/성공 |
| `#8A5300` / `#FFF4DE` | 5.80:1 | 인증 만료/주의 |

일반 텍스트 4.5:1과 필요한 비텍스트 UI 3:1 등의 기준은 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)에 따라 평가한다. 이 표만으로 전체 AA 적합성을 선언하지 않는다.

## 4. 디자인 토큰 구현 명세

토큰은 `src/styles/tokens.css`로 분리하는 것을 기본으로 한다. 아래는 계획용 정의이며 이 요청에서 제품 CSS에 적용하지 않는다.

```css
:root {
  --color-bg: #f8f8f8;
  --color-surface: #ffffff;
  --color-text: #000000;
  --color-text-strong: #111111;
  --color-text-secondary: #707070;
  --color-text-secondary-on-surface: #757575;
  --color-border: #cfcfcf;
  --color-control-border: #757575;
  --color-disabled: #b3b3b3;
  --color-accent: #f1fd82;
  --color-success: #24633c;
  --color-success-bg: #eff7f0;
  --color-warning: #8a5300;
  --color-warning-bg: #fff4de;
  --color-danger: #b42318;
  --color-danger-bg: #fff1f0;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-24: 96px;
  --space-40: 160px;
  --space-60: 240px;

  --radius-card: 20px;
  --radius-pill: 50px;
  --radius-full: 999px;
  --radius-circle: 50%;
  --shadow-floating: 0 8px 24px rgb(0 0 0 / 9%);
  --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI',
    'Malgun Gothic', sans-serif;
  --font-display: 'Anthro', var(--font-ui);
  --text-display: 64px;
  --text-h1: 45px;
  --text-h2: 32px;
  --text-h3: 24px;
  --text-body-lg: 16px;
  --text-body: 14px;
  --text-caption: 12px;

  --control-height: 48px;
  --button-icon-inset: 6px;
  --focus-width: 2px;
  --focus-offset: 4px;
  --duration-fast: 160ms;
  --duration-normal: 200ms;
}
```

### 토큰 사용 규칙

- normal primary는 검정/흰색, accent는 lime/검정, destructive는 danger/흰색이다. 삭제 확인을 lime CTA로 강조하지 않는다.
- disabled 색은 비활성 면/아이콘에 사용한다. 작동하지 않는 이유는 별도 도움말로 읽을 수 있어야 하며 `disabled`/`aria-disabled` 의미를 제공한다.
- 일반 패널은 `white + 20px + 24–40px padding`, border/shadow 없음. dropdown/dialog에만 floating shadow를 사용한다.
- 입력은 높이 48px·20px radius·16px padding. 식별 경계 1px, focus 2px/4px offset. 오류색만으로 입력 오류를 표시하지 않는다.
- white/gray 배경에서 검정 focus, 검정 면에서는 흰 focus를 사용한다. 실제 ring과 인접 면 대비를 검사한다.
- lime는 한 작업 영역에 주요 시작 CTA 또는 선택 badge로 제한한다. 5–15%는 시안 검토의 가이드이며 면적을 늘리기 위한 최소 목표가 아니다.
- 링크 hover에 전체 opacity를 낮춰 대비를 잃지 않게 한다. nav는 상태 배경, 본문 링크는 underline으로 변화시킨다.
- 애니메이션은 opacity/background 위주다. 행 위치 이동·progress width 변화가 포커스나 버튼 좌표를 흔들지 않게 한다.

### 서체와 한글

현재 저장소에는 Anthro/Inter 제품용 파일과 라이선스 증거가 없다. 초기 프로토타입은 위 fallback으로 작성 가능하다. 구현 D02에서 Inter 공식 배포의 라이선스를 확인해 로컬 WOFF2와 고지 파일을 함께 관리한다. Anthro는 사용 권한과 파일이 확보된 경우에만 `@font-face`로 등록하고, 없으면 Inter/시스템 폰트로 출시한다.

한글은 지원되는 시스템 서체로 fallback한다. 서로 다른 OS에서 영문/한글 기준선·굵기·행 높이를 비교하고 레이아웃을 조정한다. 외부 폰트 CDN 요청을 필수로 만들지 않는다. `font-display: swap`을 사용하고 무거운 폰트 전체를 초기 preload하지 않는다.

| 용도 | desktop | mobile | 비고 |
| --- | --- | --- | --- |
| 페이지 H1 | 45px / 56px / 600 | 32px / 40px / 600 | 한글 줄 높이 보완 |
| 작업 섹션 H2 | 24px / 32px / 500 | 24px / 32px / 500 | 원본 32px H2는 인증/큰 제목에 한정 |
| 인증 제목 | 32px / 40px / 500 | 24px / 32px / 500 | 짧은 문구 |
| 본문·파일명 | 16px / 24px | 동일 | 파일명 600, 설명 400 |
| 버튼·라벨·상태 | 14px / 20px, 입력은 16px / 24px | 동일 | 모바일 입력 글씨 16px 유지 |
| 보조 캡션 | 12px / 20px | 동일 | 핵심 오류·만료 행동은 14px 이상 |
| PIN/TOTP | 32px / 40px | 동일 | 실제 단일 input, tabular-nums |

64px display는 자산으로 보존하되 기본 작업 화면에는 사용하지 않는다. 영문/한글 제목의 고정 높이·강제 두 줄 분할은 피한다.

## 5. 앱 구조와 반응형 레이아웃

### 앱 셸

- 로고 왼쪽, 받기/올리기 탭 중앙 또는 바로 옆, 내 기기 보조 링크 오른쪽.
- ‘Temporary Drop’ 제품명을 유지하고 별도 영문 슬로건은 제거한다. 작은 자체 SVG 마크를 사용한다.
- 선택 탭은 `aria-current=page`와 검정 pill/흰 텍스트로 구별한다. 내 기기는 한 번의 클릭/탭으로 진입한다.
- header 아래 PageHeader와 AccessStatus를 배치한다. 받기/올리기 권한을 합쳐 ‘로그인됨’으로 표현하지 않는다.
- 활성 업로드가 다른 페이지에 있으면 작은 TransferDock을 표시한다. 전체 목록으로 돌아가기만 제공하고 전송 완료를 추정하지 않는다.
- 원본의 스크롤 후 별도 floating nav는 도입하지 않는다. 작은 화면에서 키보드·메뉴·TransferDock이 서로 겹치지 않게 한다.
- 로컬 환경 표시는 보조 영역에 유지한다. 일반 운영 화면에 내부 저장소 이름을 안내하지 않는다.

| 범위 | 컨테이너·간격 | 주요 배치 |
| --- | --- | --- |
| desktop ≥1000px | shell max-width 1440px, 좌우 48px, header 80px, main 시작 48px | 넓은 파일 행, 상단 상태/행동 한 줄, 섹션 간 40px |
| tablet 730–999px | 좌우 32px, header 최소 72px, main 시작 40px | 상태 영역 줄바꿈, 행의 metadata를 두 번째 줄로 |
| mobile ≤729px | 좌우 16px, header 두 줄 허용, main 시작 32px | 이름→metadata/만료→상태/진행→행동 순서 |

인증 panel의 최대 폭은 480px, dialog는 560px, 설명 문단은 640–760px 안에 둔다. 인증 panel padding은 desktop 40px/mobile 24px. header/nav 높이는 최소값이고 확대 시 내용 높이에 맞춰 늘어난다.

UI breakpoint 729/999px와 업로더의 현재 `matchMedia(max-width:719px)` 자원 정책을 분리한다. 시각 breakpoint를 교체하면서 네트워크 part 슬롯을 자동으로 늘리지 않는다. 자원 정책은 이번 범위에서 유지하고 주석으로 목적을 설명한다.

### 공통 파일 행

desktop에서 파일 정보가 남는 폭을 사용하고 크기·만료·행동은 필요한 만큼 배치한다. grid의 파일명 열은 `minmax(0, 1fr)`, 행동은 다운로드/삭제 라벨을 모두 표시할 폭을 확보한다. 각 행은 24px 내부 여백과 8–16px 세부 간격을 가진다. 목록 전체를 한 white panel에 담고 일반 행마다 shadow/card를 중첩하지 않는다.

mobile에서는 아래 구조를 사용한다.

```text
[파일 아이콘] 파일명 최대 2줄                 [상태]
              크기 · 완료 시각
              남은 시간 · 정확한 만료 시각 보기
              [다운로드]                 [삭제]
```

전체 이름은 펼치기나 접근 가능한 세부 텍스트로 제공한다. 파일명 tooltip만으로 해결하지 않는다. 좁은 화면에서는 행동 줄을 파일명 아래로 보내고 버튼을 최소 44px 터치 영역으로 유지한다.

## 6. 화면별 구현 명세

### S01 — 받기 잠금 / 최초 연결

```text
Temporary Drop          [파일 받기] [파일 올리기]          내 기기

파일 받기
다른 기기에서 올린 파일을 받아보세요.

                    white / radius 20 인증 panel
                    다운로드 PIN
                    [단일 마스킹 입력]
                    □ 내 기기에서 30일 동안 기억
                    공용 PC에서는 선택하지 마세요.
                    [파일 목록 열기 — black pill]
```

파일명·개수·가짜 파일 skeleton을 인증 전에 보여주지 않는다. 인증 확인 중에는 인증 영역의 generic loading만 사용한다. 연결 실패는 같은 위치에서 다시 연결하도록 하고 모든 화면에 같은 안내 카드를 반복하지 않는다. PIN 입력이 전송 엔진을 mount/unmount하지 않게 한다.

### S02 — 받을 수 있는 파일

PageHeader에 제목과 짧은 보관 설명, AccessStatus에 다운로드 잠금 해제 상태와 잠금 행동을 배치한다. toolbar에는 ‘불러온 파일 N개’·마지막 확인·새로고침을 둔다. 파일 목록은 white panel, 다운로드는 black pill, 삭제는 danger text/secondary 행동으로 구분한다.

상단 타이틀에 45px 위계를 사용하되 파일 정보까지 160px 이상의 빈 공간을 만들지 않는다. 목록 안에서는 파일명과 만료가 장식 badge보다 먼저 읽혀야 한다. 더 보기 버튼은 목록 바로 아래에 둔다.

최초 로딩·빈 목록·모두 만료·갱신 실패·더 보기 실패·세션 만료는 각각 별도 상태다. 갱신 오류는 기존 목록 옆에 표시하고 401/세션 만료에는 목록을 지운다. ID 기준 병합으로 중복 행을 막는다.

**pagination 정책:** 사용자가 더 보기를 누른 범위를 기록한다. 자동/수동 새로고침은 그 범위의 페이지를 cursor 순으로 다시 받아 미만료 항목을 재구성한다. 첫 페이지 성공만으로 기존 뒤 페이지를 잃거나 전체 목록이라고 표시하지 않는다. 중간 실패 시 기존 페이지를 유지하고 마지막 확인 시각을 표시한다. 요청 세대 ID/abort로 오래된 응답이 최신 목록을 덮어쓰지 않게 한다.

### S03 — 파일 삭제 dialog

파일 삭제는 다운로드 선택과 독립 행동이다. 행의 ‘삭제’를 누르면 snapshot 대상 파일명·ID를 dialog에 고정하고 첫 focus는 제목/취소에 둔다. destructive 버튼에 자동 focus하여 Enter로 바로 지워지게 하지 않는다.

```text
파일을 영구 삭제할까요?
[대상 파일의 전체 이름]
삭제 후 다른 기기에서 새로 다운로드할 수 없으며 복구할 수 없습니다.

신뢰 브라우저:              공용/미신뢰 브라우저:
[취소] [영구 삭제]           Authenticator 코드 [단일 입력]
                            [취소] [인증하고 영구 삭제]
```

유효한 다운로드 인증은 두 분기 모두 필요하다. 삭제 시점의 서버가 신뢰 브라우저를 인정하지 않으면 새 TOTP 분기로 다시 안내하며 클라이언트 auth 값만으로 권한을 보장하지 않는다. `intent=delete_file`, 해당 `targetId`, 반환된 grant로 DELETE를 수행한다.

| 삭제 UI 상태 | 표시·행동 |
| --- | --- |
| 확인 대기 | 대상 이름·복구 불가·취소·인증 조건 |
| 코드 인증 중 | 중복 제출/대상 변경 방지, 인증 상태 표시 |
| 삭제 중 | ‘삭제 중…’, 중복 요청/닫기 방지. 상태가 장시간 불명확하면 결과 확인 안내 |
| 서버 DELETED | 대상 행 제거, 완료 안내, 다음 행/목록 제목으로 focus |
| DELETE_IN_PROGRESS | 이미 처리 중임을 알리고 목록 재조회, 성공 선언 금지 |
| DELETE_FAILED | 목록 숨김과 저장소 정리 지연을 분리해 설명, 자동 정리 안내·재조회 |
| 권한/코드 오류 | dialog 안에 오류, 대상 유지, 조건에 맞는 재인증 |
| 파일 없음/만료 | 목록 재조회, ‘더 이상 받을 수 없음’ 안내. 이 요청의 삭제 성공으로 단정하지 않음 |
| 네트워크 응답 불확실 | 결과 재조회, 조회가 불가능하면 완료 여부 미확인으로 표시 |

공개 목록에서 사라진 사실만으로 DELETED라고 판단하지 않는다. 현재 API에는 삭제 작업 상태 전용 조회가 없으므로 최초 DELETE 성공 응답으로만 확정 완료를 알린다. 필요 시 사용자 확인 후 동일 대상으로 다시 DELETE하되, 미신뢰 브라우저는 새 대상별 grant가 필요하다. 무한 자동 삭제 재시도는 하지 않는다.

이미 내려받은 파일/수신 바이트를 회수하지 않는다는 제한은 도움말에서 확인할 수 있게 한다. bulk delete·undo·휴지통 버튼은 추가하지 않는다.

### S04 — 업로드 인증

받기 인증과 같은 panel 규칙을 사용한다. ‘파일 올리기’와 6자리 Authenticator 코드, 기본 OFF의 개인 기기 등록, 조건부 기기 이름, 15분 동안 새 파일 시작 가능 안내를 제공한다.

입력은 실제 하나의 text field다. 장식된 여러 코드 칸을 구현하더라도 input을 6개로 나누지 않는다. iOS 입력 글씨는 16px 이상이고 숫자 키패드·paste·`one-time-code`를 지원한다. 이 panel에서는 신뢰 등록을 강조해 자동 선택을 유도하지 않는다.

### S05 — 업로드 선택 / 검토 / 진행

현재 상시 큰 드롭 영역과 오른쪽 보관 안내 카드를 아래 구조로 바꾼다.

```text
파일 올리기                          [업로드 접근 상태 / 종료]
다른 기기에서 받을 파일을 잠시 보관하세요.

선택 전: white 파일 선택 panel + 보관 기간 + 파일 선택

선택 후: [파일 추가] 기본 보관 [24시간]
         선택한 파일 N개 · 총 크기
         파일별 이름 / 크기 / 보관 기간 / 제거
         [N개 파일 업로드 시작 — lime pill]

시작 후: 진행 중 / 승인 전 대기 / 완료·취소 항목을 구별한 목록
         진행 행: 이름·상태·bar·현재 전송량·속도·취소
```

최초 drop panel padding은 desktop 40px/mobile 24px이며 고정 300px 높이를 강제하지 않는다. 파일 선택 후에는 FileComposer를 짧은 toolbar로 바꾸고 목록을 위로 올린다. 추가 선택 파일은 승인 전 대기이며 이전 처리 승인에 자동 포함하지 않는다.

완료/취소 항목은 같은 화면에서 유지하고 summary에서 개수를 표시한다. 행을 상태 변경 때마다 다른 위치로 자동 재정렬하여 작업 대상을 놓치게 하지 않는다. grouping이 필요하면 안정된 group/key와 focus 규칙을 유지한다.

보관 기간은 native select로 시작한다. 4개 선택지를 버튼 네 개로 항상 펼쳐 모바일 폭을 소모하지 않는다. 기본값은 이후 선택 파일, 개별 값은 그 대기 파일만 변경한다. 서버 생성 이후에는 읽기 전용 metadata로 전환한다.

전송률 bar는 검정으로 시작한다. 성공하면 success 라벨/아이콘으로 바꾸고 lime를 완료·실패 의미에 혼용하지 않는다. 100%·확인 중과 READY는 별도 상태다. ETA는 P1이며 첫 구현에 추가하지 않는다.

### S06 — 공용 인증 만료 / 오프라인 / 접근 종료

- AccessStatus에 새 파일 시작 가능 시간과 ‘이 브라우저에서 종료’를 모은다. 임계 경고는 2분 이하에서 한 번 알려주고 매초 announce하지 않는다.
- 자연 만료는 warning strip+재인증, 승인 전 파일 유지, 기존 생성 전송 지속이다. 엔진을 clear하거나 파일 ID를 새로 만들지 않는다.
- 오프라인은 영향받은 파일 행에 상태를 표시한다. 동일한 메시지를 전역 banner와 모든 행에 과도하게 반복하지 않는다.
- 종료 dialog는 취소 가능한 파일 수와 FINALIZING의 완료 가능성을 설명한다. 다운로드 잠금·공용 전체 종료·신뢰 기기 권한 해제를 서로 다른 행동으로 제공한다.
- 앱 내부 이동은 전송 유지, 새로고침/닫기는 중단 가능 안내 및 기존 beforeunload로 처리한다. 새로고침 후 복원 기능을 시안에 넣지 않는다.

### S07 — 내 기기 / 해제 / 단축어

제목 아래 white 목록에 기기명·유형·현재 등록·마지막 사용·권한 해제를 배치한다. 무의미한 저장 공간·전송 그래프·프로필 avatar를 추가하지 않는다. 데이터가 없는 기기 이름은 추정해서 만들지 않는다.

기기 해제는 현재 방식대로 대상별 새 TOTP를 요구한다. 현재 브라우저를 해제하면 인증 상태와 활성 전송을 재확인한다. 단축어 연결은 이름→재인증→1회 토큰→설정 안내다. token textarea는 줄바꿈/전체 선택이 가능하고 복사 오류는 dialog 안에 남긴다.

1회 토큰 화면을 닫는 경우에는 저장 여부 확인 흐름을 제공한다. 실제 설치 파일이 없으므로 ‘설치 완료’ 화면을 만들지 않는다.

## 7. 컴포넌트 계약과 파일 구조

새 파일은 구현 시 생성한다. 모든 primitive를 일반 UI 라이브러리로 추상화하지 않고 현재 P0 화면에서 반복되는 책임만 분리한다.

```text
src/
  App.tsx                    # composition root, singleton engine 연결 유지
  api.ts                     # 기존 HTTP/CSRF 계약
  uploader.ts                # 기존 전송 엔진 + 승인/결과 조회 보완
  styles.css                 # 스타일 import 진입점
  styles/
    tokens.css
    base.css
    components.css
    features.css
  components/
    AppShell.tsx             # header/nav/AccessStatus/TransferDock
    Button.tsx               # button 및 다운로드 anchor의 일관된 appearance
    FormField.tsx            # label/help/error, 숫자 코드의 실제 단일 입력
    StatusMessage.tsx        # inline error/notice/empty/loading
    Dialog.tsx               # 포커스/닫기/busy/복귀 공통 처리
    FileIdentity.tsx         # 자체 SVG, 긴 파일명/크기
  hooks/
    useRoute.ts
    useAuthStatus.ts
  features/
    auth/AuthForms.tsx        # PIN, TOTP 목적별 form
    upload/UploadPage.tsx     # composer/검토/전송 목록
    upload/UploadItem.tsx
    download/DownloadPage.tsx # 목록/페이지 조회/lock
    download/DeleteFileDialog.tsx
    devices/DevicesPage.tsx   # 목록/해제/토큰 단계
  lib/
    format.ts                # byte/retention/time/timezone 공통 표기
    transferView.ts          # 엔진/오류 → 표시/허용 액션 매핑
```

| 구성 | 핵심 입력·상태 | 구현 계약 |
| --- | --- | --- |
| Button | primary/accent/secondary/destructive/quiet, busy, disabled | 높이 48px, 이름 유지, 위험 행동은 lime 금지 |
| FormField/CodeInput | label, hint, invalid, length | 단일 input, 연결된 오류, Enter/paste |
| AccessStatus | 화면 권한·만료·이용 방식 | 올리기/받기 독립, 종료 scope 표시 |
| StatusMessage | loading/empty/info/warning/error | 오류를 일시 toast만으로 전달하지 않음 |
| Dialog | title, description, busy, initialFocus, returnFocus | native dialog, unique ID, 삭제 후 대체 focus |
| FileIdentity | name, bytes, kind | text 안전 출력, 전체 이름 접근, 동일 SVG 계열 |
| UploadItem | QueueView + 확장된 오류/액션 | progressbar와 파일명 연결, 가능한 행동만 표시 |
| DownloadRow | FileSummary, now, delete pending | 다운로드/삭제 분리, 만료 즉시 행동 갱신 |
| TransferDock | 실제 active count | 페이지 이동이 engine 재생성 안 함, body 내용 안 가림 |
| TokenStep | token in memory, copy status | 닫기 시 값 제거, session replay/analytics 수집 없음 |

아이콘은 전송 방향·파일·잠금·기기·경고·휴지통 등 필요한 약 10종을 작은 자체 SVG로 통일한다. 제품 이미지/외부 CDN 에셋은 필요하지 않다. 링크/버튼의 icon-only 형태는 화면 폭을 줄이는 유일한 수단으로 쓰지 않는다.

## 8. 상태·엔진 통합 상세

### 승인 전 대기 분리

전송 상태의 `queued`는 유지하되 엔진 내부 QueueItem에 승인 여부를 추가한다. QueueView에는 표시가 필요한 `approved` 값을 전달한다.

1. `add()`는 `approved=false`로 추가한다. 이후 `pump()`가 실행되어도 그 파일을 생성하지 않는다.
2. `start(keys)`는 요청한 현재 `queued/needs_auth` 항목만 승인한다. 기존 모든 항목을 암묵적으로 시작하는 동작을 제거한다.
3. `pump()`는 승인된 queued만 슬롯에 배정한다. 새 선택 파일은 승인된 처리 대기와 구분한다.
4. 공용 인증 만료로 `needs_auth`가 되면 이미 처리 승인했더라도 명시적으로 다시 시작하도록 한다. 재인증 성공만으로 미승인 파일을 시작하지 않는다.
5. UI는 현재 대기 키 snapshot을 시작 요청에 전달한다. 버튼 클릭 이후 추가된 파일은 포함되지 않는다.
6. 새로 시작 행동은 실패한 그 파일에만 적용한다. idempotency key와 confirmed/inFlight 초기화는 기존 재시작 정책을 지킨다.

파일 2개·part 슬롯 4/2개·64 MiB 정책은 변경하지 않는다. state/metadata 승인 변화가 파일 바이트 전송을 중복 생성하지 않는지 기존 uploader 시험에 추가한다.

### 결과 확인 지연과 취소 오류

QueueView에 `errorCode`, 복구 종류(`check_result`/`restart`/`confirm_cancel`/`reauth`)를 전달한다. UI는 오류 문자열 파싱으로 버튼을 고르지 않는다. `canCancel`은 confirmed state와 현재 단계에서 결정하며 서버가 최종 권한을 판단한다.

`FINALIZE_PENDING` 이후 결과를 확인할 수 있도록 원래 ID와 capability를 유지한다. 실패 처리의 일반 abort 경로로 결과 조회까지 막지 않게 엔진 흐름을 분리한다. 조회 READY는 기존 result로 완료, FINALIZING은 확인 대기, 권한 만료는 확인 불가를 알린다. 확인 중에 새 upload ID를 만들지 않는다.

취소 확인 실패도 같은 파일 ID로 상태를 확인한다. READY이면 완료, 취소 확정이면 cancelled, 응답 불확실이면 미확인 상태를 유지한다. 실제 가능한 서버 상태를 [API 계약](../API.md)과 대조하여 매핑한다.

### 인증 시계와 불확실한 권한

`useAuthStatus`는 last successful AuthStatus·server offset·request state를 나눈다. 반복 조회 실패가 기존 큐를 숨기지 않게 한다. 새 업로드·삭제 등에는 권한을 재확인하고 서버 오류를 기준으로 분기한다.

`now`를 필요한 컴포넌트에서만 구독하여 매초 전체 App을 다시 그리는 구조를 줄인다. expiry 알림은 의미 있는 경계만 announce한다. 탭 visibility 복귀 시 인증/목록을 확인하고 race를 막는다.

### 삭제와 전송 이력의 연결

서버 파일 삭제를 upload queue의 `remove()`로 처리하지 않는다. 삭제 성공 시 같은 ID의 완료 이력이 열려 있다면 ‘서버 파일 삭제됨’을 재현 가능한 화면 상태로 표시하여 만료 시각이나 받기 이동이 여전히 유효해 보이지 않게 한다. 메모리의 결과 ID 연결로 처리하고 기존 파일 content를 읽거나 보존하지 않는다.

다른 브라우저에서 삭제한 완료 파일의 상태를 임의로 실시간 보장하지 않는다. 받기 목록 재조회에서 확인되는 사실을 따르고 장기간 열린 업로드 이력은 ‘이 탭의 전송 이력’임을 명시한다.

## 9. 단계별 구현 백로그

단계는 의존 순서로 실행한다. 각 단계에서 검증을 통과한 뒤 다음 단계로 이동하고, 디자인 변경과 전송 동작 변경을 별도 변경 묶음으로 검토한다.

| ID | 작업·책임 파일 | 완료 조건 | 검증/의존 |
| --- | --- | --- | --- |
| D01 | 현재 S01–S07·PRD QA-01–20 대응표, A/B/C 구조 비교 | 동일 예시/상태로 desktop/mobile 비교, 구조 선택 근거 기록 | 이 문서·PRD·현재 API, 기존 운영 정보는 실측과 분리 |
| D02 | tokens/base/font/icon 결정 | 대비·한글 줄 높이·pill/card 규칙 확정, 폰트 권한 없으면 fallback 고정 | D01, 320/390/768/1440·729/730/999/1000 검사 |
| D03 | AppShell·Button·FormField·Dialog·StatusMessage, hook 분리 | 기존 데이터/권한 흐름을 보존하며 컴포넌트 추출 | D02, typecheck/build, 화면 이동·dialog focus |
| D04 | S01/S04 인증·AccessStatus·최초/갱신 오류 | PIN/TOTP/기억/신뢰·목적별 인증·재시도 시간이 일치 | D03, QA-01/02/05, 기본 OFF·인증 전 노출 검사 |
| D05 | uploader 승인·errorCode·결과 조회 계약 | 미승인 자동 생성 0건, 지연 결과에 새 ID 생성 0건 | D03, 의미 있는 uploader 회귀 추가, QA-03–08 |
| D06 | UploadPage/Item·파일 선택·보관·전송·Dock | S05/S06 모든 state·행동·반응형 구현, engine singleton 유지 | D04/D05, QA-02–08/13 |
| D07 | DownloadPage·pagination·expiry·lock | 조회 범위 유지·중복 행 방지·401 정리·다운로드 행동 | D04, QA-01/09/10 |
| D08 | DeleteFileDialog·목록 연동·확인 이력 | 신뢰/TOTP 두 분기·처리 지연·focus·다른 파일 유지 | D06/D07, 기존 삭제 API 시험 + QA-15–20 |
| D09 | DevicesPage·기기 해제·TokenStep | 대상별 TOTP·현재 등록 영향·1회 토큰과 닫기 확인 | D04/D06, QA-11/12 |
| D10 | old CSS/중복 컴포넌트 제거, 상태·copy 일치 | 기존 녹색 스타일 잔존과 죽은 UI 경로 없음, 모든 P0 매핑 | D06–D09, 전 상태·확대·키보드 점검 |
| D11 | 통합·접근성·파일 검증·전달 | PRD 출시 조건과 아래 acceptance evidence 충족 | D10, npm check/dry-run·브라우저·실기기 |

실제 배포·Git push는 후속 구현 요청의 범위에 따라 진행한다. 계획 작성만으로 운영 데이터의 삭제·토큰 발급·배포를 수행하지 않는다.

### PRD 추적성

| 요구사항 | 구현 단계 | 핵심 검사 |
| --- | --- | --- |
| FR-AUTH-01–06 | D03/D04 | 단일 입력·paste·기본 OFF·목적·재인증 중 전송 유지 |
| FR-UP-01–06 | D05/D06 | 파일 선택·대기 승인·보관 기준·제한·배치 변화 |
| FR-UP-07–12 | D05/D06 | 상태·100%/READY·만료·취소·탭 수명·화면 이력 |
| FR-DOWN-01–07 | D07 | 정보 보호·목록·cursor·시각·다운로드·잠금 |
| FR-DOWN-08–13 | D08 | 대상 삭제·확인·권한·DELETED·지연·회수 범위 |
| FR-ACCESS-01–05 | D04/D06/D09 | 종료 scope·finalizing·신뢰 해제·대상 기기 |
| FR-ACCESS-06–08 | D09 | 토큰 1회 표시·복사/닫기·설치 미완료 안내 |

## 10. 디자인·동작 검증 계획

### 화면 evidence

같은 합성 파일명/크기/시간으로 다음 조합을 capture한다. 개인정보·실제 파일 내용·운영 토큰은 사용하지 않는다.

| 묶음 | 필요한 상태 | 폭 |
| --- | --- | --- |
| 인증 | PIN/TOTP 기본·오류·신뢰 선택·rate limit | 390/1440, 320 경계 |
| 업로드 | 빈 선택·검토·2개 전송+미승인 추가·100% 확인·완료 | 390/768/1440 |
| 복구 | 공용 만료·재인증·오프라인·확인 지연·취소 실패 | 390/1440 |
| 받기 | 여러 파일·긴 이름·빈 목록·만료·더 보기/갱신 실패 | 320/390/768/1440 |
| 삭제 | 신뢰 확인·TOTP 확인·오류·처리·정리 지연·삭제 후 focus | 390/1440 |
| 기기 | 목록·현재 기기 해제·토큰·복사 오류·닫기 확인 | 390/1440 |

729/730px와 999/1000px에서 메뉴·행동이 사라지거나 겹치지 않는지 별도 확인한다. 정상 viewport 외 200% 텍스트/400% 브라우저 확대, 모바일 키보드, safe area도 검사한다.

### 자동 검증

- 스타일·문서 단계에는 포맷 검사와 실제 화면 검토를 사용한다. 디자인 수치와 일대일 대응하는 테스트를 무의미하게 추가하지 않는다.
- 동작 변경에는 기존 uploader 시험을 확장하여 승인 전 대기·인증 후 시작·결과 조회·ID 유지·재시작 대상 범위를 검사한다.
- 삭제는 기존 `immediate file deletion` 통합 시험의 신뢰 브라우저·다운로드 인증·CSRF·대상 grant·저장소 실패·용량 1회 해제를 재사용한다.
- 통합 완료 시 `npm run check`와 `npm run deploy:check`를 실행한다. 후자는 원격 배포가 아닌 dry-run이다.
- 기존 HTTP smoke로 multipart·Range·해시 회귀를 검사한다. 로컬 코드·비밀은 로그나 산출물에 붙이지 않는다.

### 브라우저·수동 검증

실제 Worker가 제공하는 UI에서 과업을 수행한다. 디자인 prototype의 성공 화면을 실제 인증/전송 성공 증거로 쓰지 않는다.

작은 파일 2개와 64 MiB+1 합성 파일의 업로드/다운로드를 확인하고 크기와 SHA-256을 대조한다. 화면 이동·15분 경계·오프라인·삭제는 PRD QA 조건대로 확인한다. 파일별 6시간 제한과 실패 정책도 UI 문구와 대조한다.

실제 저장 파일 삭제 시험은 합성 fixture를 사용하는 로컬/격리 검증 환경에서 진행한다. 운영의 개인 파일을 삭제하여 버튼을 시험하지 않는다. iPhone/Safari/VoiceOver 증거가 없으면 해당 시험을 미완료로 남긴다.

### 성능·출시 판정

현재 production build의 초기 JS 크기·첫 작업 표시·목록 반응을 같은 조건으로 기록한다. 새 폰트/컴포넌트 도입에 따른 10% 초과 악화를 조사하고 무거운 패키지를 기본값으로 넣지 않는다. progress 갱신은 최대 초당 4회 정도의 표시 갱신을 목표로 하되 실제 전송 상태 이벤트를 늦추지 않는다.

출시 전 증거 묶음에는 선택안·토큰/컴포넌트 계약·상태별 capture·요구사항 대응·자동 검사 결과·실제 파일 hash·접근성 수동 결과·알려진 제한을 포함한다. PRD QA-01–20 중 권한 우회·다른 파일 삭제·중복 전송·확인 전 성공 표시·중단 회귀는 출시 차단이다.

## 11. 결정·제약·범위 요약

| 항목 | 기본 결정 | 남은 조건 |
| --- | --- | --- |
| 시각 언어 | 사용자 제공 Assemble 시스템 | 적용표의 제품 보완값으로 구체화 |
| 레이아웃 | A 전송 데스크를 구현 기준안으로 상세화 | 같은 시스템의 B/C 구조와 비교 후 선택 |
| 기능 | PRD의 모든 P0, 개별 파일 삭제 포함 | P1 검색/정렬/ETA·bulk delete는 추가하지 않음 |
| 폰트 | Inter/시스템 fallback으로 진행 가능 | Inter 자산·라이선스 확인, Anthro는 권한 확보 시만 |
| 기술 | React/CSS·현 API·singleton uploader | 작은 상태 계약 변경과 회귀 검증 |
| API 부족 | 삭제 작업 상태 전용 조회 없음 | 성공 응답 외 결과를 미확정으로 안내, 신규 endpoint는 별도 결정 |
| 브라우저 제한 | 탭 수명 안에서 연결 복구 | 재시작 후 복원·iOS background 보장 안 함 |
| 변경 전달 | 문서·후속 단계별 검증 가능한 변경 묶음 | 현재 요청에서 제품 코드·배포 실행 없음 |

## 12. 근거와 출처

- 사용자 첨부: `Assemble Design System v1.0`, 22개 절로 정규화된 토큰·버튼·카드·form·반응형 정의. 이 문서의 색/형태/spacing 기본값의 출처다.
- [Onassemble 공개 홈페이지](https://www.onassemble.com/): 2026-10-03 첫 화면/스크롤 시각 확인. 실제 홈페이지 관측과 첨부 시스템의 제안값을 구분했다.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): 대비·키보드·리플로우·포커스·상태 안내의 검증 기준.
- [프로젝트 PRD](04-프런트엔드-전면-리디자인-PRD.md), [API](../API.md), [구현 상태](../IMPLEMENTATION_STATUS.md): 기능 범위와 검증 제한.
- [App](../../src/App.tsx), [스타일](../../src/styles.css), [업로더](../../src/uploader.ts), [Worker](../../worker/index.ts): 현재 코드와 계획한 변경 경계.
