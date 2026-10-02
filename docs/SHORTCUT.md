# iPhone 단축어 연결 — API 초안

이 버전은 업로드 전용 기기 토큰 발급과 staging→final 서버 확정을 구현했습니다. **서명된 `.shortcut` 설치 파일과 iPhone 실기기 검증은 아직 제공하지 않습니다.** 아래는 실기기에서 제작·검증할 흐름입니다. 5 GiB는 API 설정 상한이며 실제 iPhone 지원 약속이 아닙니다.

## 단축어 제작 흐름

1. 공유 시트에서 파일 또는 사진을 받도록 설정합니다. 파일마다 별도 업로드를 만듭니다. 사진의 원본/변환 결과와 실제 파일 크기·확장자를 먼저 결정합니다.
2. 서비스의 내 기기에서 ‘iPhone 단축어 연결’을 선택하고 새로운 TOTP로 업로드 전용 토큰을 발급합니다. 토큰은 개인 단축어 안에만 넣고 공유 템플릿에는 빈 입력값을 둡니다.
3. 파일명·정확한 바이트 크기·MIME·보관 시간과 실행별 UUID를 준비합니다. 같은 요청의 재시도에는 같은 UUID를 유지합니다.
4. 아래 요청으로 업로드를 생성합니다.

```http
POST https://YOUR_SERVICE/api/shortcut/uploads
Authorization: Bearer YOUR_DEVICE_TOKEN
Idempotency-Key: EXECUTION_FILE_UUID
Content-Type: application/json

{"filename":"photo.heic","sizeBytes":123456,"mime":"image/heic","retentionSeconds":86400}
```

5. 반환된 `putUrl`에 원본 파일 바이트를 PUT합니다. JSON이나 multipart/form-data로 감싸지 않습니다. 반환된 `putHeaders`가 있으면 그대로 넣습니다. 기기 Bearer token을 R2 URL로 보내지 않습니다. URL을 로그·알림에 표시하지 않습니다.
6. 아래 요청으로 확정을 실행합니다.

```http
POST https://YOUR_SERVICE/api/uploads/RETURNED_ID/complete
Authorization: Upload RETURNED_CAPABILITY
Content-Type: application/json

{}
```

7. 202 또는 네트워크 오류이면 동일 fileId의 상태를 조회합니다. READY가 확인된 후에만 성공을 표시합니다. UPLOADING이면 PUT/complete 재시도를 판단하고, FINALIZING이면 기다립니다. 서버는 원본 staging의 HEAD 크기와 ETag를 고정해 conditional CopyObject를 수행한 뒤 final HEAD를 검증합니다.
8. CANCEL_REQUESTED, FAILED, DELETED 등 실패 상태에는 완료 메시지를 표시하지 않습니다. 새로 시도할 때 새로운 업로드를 생성합니다. 취소 요청에는 해당 파일의 capability를 사용합니다.

Shortcuts의 URL 요청 및 request body 유형은 [Apple API 요청 안내](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios)를 참고합니다. 파일을 raw body로 보내는 세부 동작과 공유 입력의 메모리·백그라운드 동작은 해당 OS에서 직접 검증해야 합니다.

로컬 에뮬레이터에서는 `putUrl`이 같은 컴퓨터의 shortcut-body endpoint입니다. iPhone의 localhost는 iPhone 자체이므로 현재 8787 주소로 실기기 검증할 수 없습니다. HTTPS staging 환경이 필요합니다.

## 설치 파일 제작 전에 확인할 항목

| 항목                             | 확인 방법                                                  |
| -------------------------------- | ---------------------------------------------------------- |
| 100 MiB / 1 GiB / 최대 지원 크기 | Files·사진 각각, 시작/완료 시간·실패 여부·기기 OS 기록     |
| 입력 파일 크기                   | 파일 action의 크기가 bytes인지 확인, PUT 후 서버 HEAD 일치 |
| raw PUT                          | R2에 JSON·form envelope 없는 원본 바이트 저장 확인         |
| 네트워크 중단                    | 생성/PUT/complete 각각 중단, 동일 요청 재실행·상태 조회    |
| 잠금/앱 전환                     | foreground→잠금→복귀별 결과, 백그라운드 보장 문구 금지     |
| 덮어쓰기 방어                    | staging 재PUT 후 final bytes가 바뀌지 않음                 |
| source 경합                      | HEAD 후 staging 변경 시 조건부 복사 거부                   |
| 권한 폐기                        | 폐기된 token으로 새 생성·후속 capability 요청 거부         |
| template 보안                    | 개인 token·capability·signed URL 없는 공유 템플릿          |

검증한 크기보다 낮은 제품 상한을 설정한 뒤 실제 설치 파일을 제작·서명·배포합니다. 실패 시 Safari multipart 흐름을 안내합니다.
