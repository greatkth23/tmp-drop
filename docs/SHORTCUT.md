# iPhone 단축어 제작 — iOS 27.0.1 / Mac 없음

운영 설정 안내는 [아이폰에서 파일 보내기](https://drop.rmarkfcl.workers.dev/shortcut)입니다. 현재는 iPhone 단축어 앱에서 직접 제작하는 방식입니다. 서버 API는 실제 R2 전송으로 검증했고 iPhone 실기기 실행은 아직 확인하지 않았습니다.

## 설치 파일 상태

서명 없는 소스를 설치 파일로 제공하지 않습니다. GitHub macOS runner에서 Apple 공식 `shortcuts sign --mode anyone`을 시험했지만 iCloud 로그인이 필요하다는 오류로 실패했습니다. Apple 계정 정보를 CI에 추가하지 않았습니다. 개인 토큰을 포함하지 않는 제작용 소스와 자체 wiring 검증만 자동 생성합니다.

- 첫 시험: 파일 앱의 작은 텍스트 파일 하나, foreground 유지.
- 입력: 공유 시트의 파일·사진. 사진은 iOS 공유 중 변환될 수 있으므로 원본 여부를 직접 확인합니다.
- 기본 보관: 86400초(24시간). 다른 값: 3600, 21600, 259200.
- 5 GiB는 API 정책 상한이며 iPhone에서 시험한 크기가 아닙니다.

## 직접 만드는 순서

액션 이름은 iOS 언어·버전에 따라 조금 다를 수 있습니다. 중괄호는 단축어 변수를 뜻하며 문자 그대로 입력하지 않습니다.

1. 단축어 앱에서 `Temporary Drop`을 만들고 세부사항에서 **공유 시트에 표시**를 켭니다. 입력 유형은 파일·이미지입니다. 처음에는 파일 하나만 시험합니다.
2. 웹의 **내 기기 → iPhone 단축어 연결**에서 새 TOTP 코드로 업로드 전용 토큰을 발급합니다. 이 화면을 닫으면 다시 볼 수 없습니다.
3. 단축어 첫 **텍스트** 액션에 토큰을 붙여 넣고 `기기 토큰` 변수로 지정합니다. PIN·TOTP 코드와 다릅니다. 이 값은 파일 생성 요청에만 사용합니다.
4. 공유 입력을 `전송 파일`로 지정합니다. 여러 파일을 처리할 때는 **각 항목 반복하기** 안에서 이후 액션을 실행하고 반복 항목을 `전송 파일`로 사용합니다.
5. **파일의 세부사항 가져오기 → 이름**을 `파일명`으로, **파일 크기**를 `바이트 크기`로 저장합니다. 크기는 숫자로 연결하고 MB 같은 표시 문자열을 사용하지 않습니다. 선언한 숫자가 실제 PUT 바이트 크기와 일치해야 합니다. 이 coercion은 iOS 27.0.1에서 직접 시험해야 합니다.
6. **임의의 숫자** 액션 3개를 1~2147483647 범위로 만듭니다. **텍스트**에서 `ios-숫자1-숫자2-숫자3`으로 연결하고 `요청 키`로 지정합니다. 서버는 UUID 형식을 요구하지 않습니다. 동일 생성 요청을 재시도할 때 이 값을 유지합니다. 단축어를 처음부터 다시 실행하면 새 요청입니다.
7. **URL 콘텐츠 가져오기**를 아래와 같이 설정합니다. JSON 필드는 텍스트/숫자 유형을 구분해 변수로 연결합니다.

| 항목             | 값                                                       |
| ---------------- | -------------------------------------------------------- |
| URL              | `https://drop.rmarkfcl.workers.dev/api/shortcut/uploads` |
| Method           | POST                                                     |
| Authorization    | `Bearer {기기 토큰}`                                     |
| Idempotency-Key  | `{요청 키}`                                              |
| Content-Type     | `application/json`                                       |
| 요청 본문        | JSON                                                     |
| filename         | 텍스트 → 파일명                                          |
| sizeBytes        | 숫자 → 바이트 크기                                       |
| mime             | 텍스트 → `application/octet-stream`                      |
| retentionSeconds | 숫자 → 86400                                             |

8. 결과를 `생성 응답`으로 저장합니다. **사전 값 가져오기**로 error가 있는지 확인합니다. error가 있으면 error 사전의 message를 알림으로 표시하고 **단축어 중단**합니다. 네트워크 오류로 액션이 실패해도 완료를 표시하지 않습니다.
9. **사전 값 가져오기**를 3개 추가해 생성 응답의 `id`, `capability`, `putUrl`을 각각 저장합니다. 필요한 값이 없으면 중단합니다.
10. **URL 콘텐츠 가져오기**: URL은 putUrl 변수, Method는 **PUT**, 요청 본문은 **파일**, 파일은 `전송 파일`입니다. JSON·base64·폼으로 감싸지 않습니다. 운영의 putHeaders는 현재 빈 사전입니다. Bearer·capability 헤더를 R2로 보내지 않습니다.
11. **텍스트** 액션으로 `https://drop.rmarkfcl.workers.dev/api/uploads/{id}/complete`를 만들며 id 변수를 연결합니다. 이 텍스트를 다음 URL 요청의 주소로 연결합니다.
12. **URL 콘텐츠 가져오기**: Method는 POST, Authorization은 `Upload {capability}`, Content-Type은 application/json, 요청 본문은 **필드가 없는 JSON**입니다. error가 있으면 message를 표시하고 중단합니다.
13. 결과의 `state`를 읽습니다. **만약** READY이면 완료 알림을 표시합니다. 그 외 상태에 성공 알림을 표시하지 않습니다.
14. FINALIZING이면 **3초 대기 → GET 상태 조회**를 최대 20번 반복합니다. 상태 주소는 `https://drop.rmarkfcl.workers.dev/api/uploads/{id}`, Authorization은 `Upload {capability}`입니다. GET 본문은 없습니다. 각 응답의 state를 다시 읽고 READY가 되면 추가 요청을 건너뜁니다.
15. 제한 안에 READY가 확인되지 않으면 현재 상태를 표시하고 중단합니다. FINALIZING은 서버 확인이 진행 중일 수 있으므로 파일 받기에서 결과를 확인한 뒤 재실행 여부를 결정합니다. 삭제·취소·실패 상태를 성공으로 표시하지 않습니다.

## 첫 실행 결과 기록

| 시험               | 확인할 것                                          |
| ------------------ | -------------------------------------------------- |
| Files 1 KiB 텍스트 | 생성 → raw PUT → READY → 목록 → 다운로드 내용 일치 |
| 파일명 한글·공백   | 원본 이름 보존, 다운로드 attachment                |
| 사진 1장           | 실제 포맷·크기·다운로드 내용, 원본/변환 여부       |
| 여러 파일          | 항목별 요청 키·ID·완료 알림, 중간 실패 시 중단     |
| 네트워크 중단      | 완료 알림이 나오지 않음, 목록 확인 후 재실행       |
| 기기 권한 해제     | 새 생성 및 후속 capability 요청 거부               |
| 화면 잠금·앱 전환  | 실제 결과 기록, 백그라운드 성공을 보장하지 않음    |

오류 `SIZE_MISMATCH`이면 숫자 크기와 PUT의 전송 파일이 같은 파일인지 확인합니다. `INVALID_INPUT`이면 JSON의 숫자/텍스트 유형을 확인합니다. `DEVICE_REVOKED`·`UNAUTHORIZED`이면 토큰을 다시 발급합니다. signed URL·capability·개인 토큰을 캡처나 로그에 포함하지 않습니다.

## 제작용 소스와 검증

Python 3.10+에서 `python scripts/build-shortcut.py`를 실행합니다. `.wrangler/shortcuts/`에 unsigned binary plist, 읽을 수 있는 XML plist, validation.json이 생성됩니다. 소스는 개인 토큰 없이 고정 운영 주소·24시간 보관·파일별 전송·오류 중단·READY 확인을 담습니다. 구조 검사와 plutil lint 성공은 iPhone 실행 성공을 의미하지 않습니다. macOS CI는 구조와 plist 형식만 검사하고 artifact 이름에 unsigned를 표시합니다.

향후 iCloud에 로그인된 Mac에서 소스를 서명할 수 있습니다. 서명·실기기 검증이 끝나기 전에는 설치 버튼을 제공하지 않습니다. 개인 토큰을 입력한 복제본은 공유하지 않습니다. iCloud 동기화·백업에도 토큰이 포함될 수 있습니다.

참고: [Apple API 요청·파일 본문](https://support.apple.com/en-in/guide/shortcuts/apd58d46713f/ios), [Apple 공유 시트 실행](https://support.apple.com/guide/shortcuts/run-a-shortcut-from-another-app-apd163eb9f95/ios), [Apple 공식 서명 명령](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac), [소스 직렬화 참고 카탈로그](https://github.com/viticci/shortcuts-playground-plugin).
