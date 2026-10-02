# 단축어 작업 1단계 검증 — 2026-10-03

대상은 사용자 제공 iOS 27.0.1, Mac 없음입니다. 이 PC에서는 iPhone 조작·실행을 검증하지 않았습니다.

운영 배포: 2bc50ea8-33bd-4fa0-b878-64dbe0c27f22. 설정 안내: https://drop.rmarkfcl.workers.dev/shortcut.

- 별도 작업 폴더에서 typecheck, format, 테스트 51개, build 통과. 기존 파일 전송 API 및 삭제 인증 정책은 바꾸지 않았습니다.
- 원격 API 시험: 임시 단축어 토큰 발급, 숫자형 metadata, 동일 요청 키 재사용, 1 KiB raw R2 PUT, READY 확정, 다운로드 바이트·SHA-256 일치. 시험 credential 등록 해제 후 새 요청은 403, 시험 파일은 삭제했습니다. SHORTCUT_API_RESULT.json에 기록했습니다.
- Chrome에서 안내 route·8개 설정 단계·실기기 미확인 표시를 확인했습니다. 390px viewport에서 가로 넘침이 없었습니다. 예제 주소 복사 뒤 성공 문구는 표시됐지만 도구의 clipboard 읽기는 빈 문자열이어서 복사 내용까지 확인했다고 기록하지 않습니다.
- 생성 소스는 78개 액션입니다. UUID 참조, UTF-16 placeholder 위치, 제어 블록 짝, 빈 개인 토큰, raw File PUT과 R2 요청의 인증 헤더 미포함을 자체 검사했습니다. iPhone에서의 File Size 숫자 coercion 및 런타임 성공은 미확인입니다.
- Apple 공식 서명 시험은 첫 실행에서 입력 확장자 문제를 수정한 후, 다음 실행에서 iCloud 로그인 필요 오류로 중단됐습니다. 서명 파일이 만들어졌다고 표시하지 않습니다. 실패 기록: https://github.com/greatkth23/tmp-drop/actions/runs/37040175575. 계정 credential을 CI에 추가하지 않았고 CI는 unsigned 소스 검증으로 전환했습니다.

다음 실기기 작업은 파일 앱의 1 KiB 텍스트 한 개로 직접 만든 단축어를 실행하고, 실제 전송 파일 크기·READY 응답·다운로드 내용을 확인하는 것입니다. 사진 입력, 여러 파일, 화면 잠금·네트워크 끊김은 그 다음 단계입니다. 설치 가능한 파일 제작은 iCloud 인증이 가능한 Apple 환경 확보 또는 iPhone에서 제작한 단축어의 공유가 필요합니다.
