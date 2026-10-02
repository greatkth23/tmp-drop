# 현재 API 계약 — v0.2.0

JSON 응답은 `Cache-Control: no-store`입니다. 오류는 `{error:{code,message,requestId,retryable,retryAfterSeconds?}}` 형태이며 `retryAfterSeconds`가 있으면 HTTP `Retry-After`도 반환합니다. JSON 입력은 16 KiB로 제한합니다.

## 권한

| 권한              | 전달                            | 허용 범위                          |
| ----------------- | ------------------------------- | ---------------------------------- |
| 신뢰 브라우저     | HttpOnly `td` cookie            | 새 웹 업로드, 기기 목록            |
| 공용 세션         | HttpOnly `ps` cookie            | 900초 내 새 웹 업로드              |
| 다운로드 세션     | HttpOnly `da` cookie            | READY 목록과 다운로드              |
| 파일별 capability | `Authorization: Upload <token>` | 해당 파일의 part, 상태, 완료, 취소 |
| 단축어 기기       | `Authorization: Bearer <token>` | 단축어 업로드 생성                 |
| 관리 grant        | `X-Admin-Grant: <token>`        | 목적·대상별 1회 관리 작업          |

운영 cookie는 `__Host-` 접두사, Secure, HttpOnly, SameSite=Strict, Path=/입니다. 로컬 cookie 접두사는 `dev-`입니다. 쿠키를 읽는 browser mutation은 `Origin`과 `X-CSRF-Token`을 검사합니다. 파일별 capability 요청은 cookie 인증을 쓰지 않습니다.

## 엔드포인트

| Method / 경로                        | 인증                                             | 입력 / 결과                                                            |
| ------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------- |
| GET `/api/health`                    | 없음                                             | `{ok,version}`                                                         |
| GET `/api/auth/status`               | 선택적 cookies                                   | auth 상태·만료·serverNow·csrfToken·limits, 파일명·개수는 없음          |
| POST `/api/auth/totp`                | Origin + CSRF                                    | `{code,intent,deviceName?,targetId?}`                                  |
| POST `/api/download/unlock`          | Origin + CSRF                                    | `{pin,remember}`; 다운로드 cookie 발급                                 |
| POST `/api/auth/logout`              | Origin + CSRF                                    | `{scope:"upload"\|"download"\|"all",activeUploads?:[{id,capability}]}` |
| GET `/api/devices`                   | 신뢰 브라우저 또는 manage grant                  | `{devices:[{id,name,kind,createdAt,lastUsedAt,current}]}`              |
| POST `/api/devices`                  | Origin + CSRF + create_device grant              | `{name,kind:"shortcut"}` → `{id,token}` 201                            |
| DELETE `/api/devices/:id`            | Origin + CSRF + target bound revoke_device grant | 새 생성·후속 전송 차단, 업로드 취소 요청                               |
| POST `/api/uploads`                  | 웹 업로드 cookie + Origin + CSRF                 | metadata + Idempotency-Key → UploadCreated 201/재호출 200              |
| POST `/api/shortcut/uploads`         | 단축어 Bearer                                    | metadata + Idempotency-Key → UploadCreated와 putUrl                    |
| PUT `/api/uploads/:id/parts/:n`      | 파일 capability                                  | raw binary → `{partNumber,etag,bytes}`                                 |
| GET `/api/uploads/:id`               | 파일 capability                                  | `{id,state,completedParts,capabilityExpiresAt,result}`                 |
| POST `/api/uploads/:id/complete`     | 파일 capability                                  | `{}` → `{state,result}`, 진행 중이면 202                               |
| DELETE `/api/uploads/:id`            | 파일 capability                                  | CANCEL_REQUESTED 202, FINALIZING/READY는 409                           |
| GET `/api/files?cursor=...&limit=25` | 다운로드 cookie                                  | `{files,nextCursor,serverNow}`; limit 1~50                             |
| GET `/api/files/:id/download`        | 다운로드 cookie                                  | 로컬 binary 200/206, 운영 signed R2 URL 302                            |
| POST `/api/local/cleanup`            | 로컬 + 웹 업로드 cookie + Origin + CSRF          | 로컬 수동 정리 결과                                                    |
| PUT `/api/uploads/:id/shortcut-body` | 로컬 + 파일 capability                           | 로컬 staging PUT 204; 운영에는 노출하지 않음                           |

`intent`는 `upload`, `trust`, `manage`, `create_device`, `revoke_device`, `maintenance_report`, `maintenance_quota`, `maintenance_delete`입니다. `trust`에는 기기 이름, `revoke_device`에는 UUID targetId가 필요합니다. 관리 grant TTL은 5분이고 한 번 소비하면 재사용할 수 없습니다.

## 업로드 metadata와 응답

```json
{
  "filename": "example.zip",
  "sizeBytes": 67108865,
  "mime": "application/zip",
  "retentionSeconds": 86400
}
```

`sizeBytes`는 양의 안전 정수이며 웹은 32 GiB, 단축어는 5 GiB 이하여야 합니다. 보관 시간은 3600/21600/86400/259200초입니다. MIME을 믿고 브라우저에 실행 가능한 파일로 제공하지 않습니다. final 객체의 Content-Type은 `application/octet-stream`, Content-Disposition은 UTF-8 attachment입니다.

```json
{
  "id": "uuid",
  "state": "UPLOADING",
  "capability": "43-character-base64url-token",
  "capabilityExpiresAt": 1790900000000,
  "partSizeBytes": 67108864,
  "partCount": 2,
  "serverNow": 1790878400000
}
```

단축어 응답에는 추가로 `putUrl`과 `putHeaders`가 있습니다. 전송할 때 반환된 headers를 그대로 사용하며 운영 PUT은 R2 S3 API로 직접 전송합니다.

각 part는 지정 번호에 맞는 정확한 크기여야 하고 마지막 part만 작을 수 있습니다. DONE 재요청은 기존 ETag를 반환합니다. SENDING은 15분 lease 후 UNCERTAIN으로 전환할 수 있으며, 실제 ListParts에 동일 크기의 part가 확인되면 DONE으로 복구합니다. 아직 미확인인 part는 409 + Retry-After입니다. 최초 전송의 결과가 불확실하면 503 PART_UNCERTAIN + Retry-After를 반환하며 업로드를 유지합니다. 저장소의 part 부재는 이전 쓰기의 종료를 보장하지 않아 재전송하지 않습니다.

staging에서는 API·정적 자산을 포함한 모든 경로에 추가 `X-Staging-Token`이 필요합니다. 사용자 인증 권한과 별개이며 누락·불일치·서버 secret 미설정은 404입니다.

## 관리 정합성 API

`POST /api/maintenance/reconcile`은 Origin/CSRF와 `X-Admin-Grant`를 요구합니다. 입력은 `{mode:"report"}`, `{mode:"repair_quota"}`, `{mode:"delete_orphans"}` 중 하나입니다. 각각의 TOTP intent `maintenance_report`, `maintenance_quota`, `maintenance_delete`로 5분·1회용 grant를 발급합니다. 다른 목적의 grant와 일반 인증만으로는 실행할 수 없습니다.

응답은 `{id,mode,createdAt,quotaBefore,quotaAfter,scanned,candidates,eligible,deleted,unknownKeys,missingReadyObjects,sizeMismatches,pages}`입니다. quota 객체는 `{reserved,ready,expectedReserved,expectedReady}`, pages는 `{prefix,hasMore}` 배열입니다. 목록은 일부 cursor 페이지이며 전체 저장소 총계가 아닙니다. 기본 report는 객체를 삭제하거나 counter를 변경하지 않습니다. 조사 기록·cursor·후보·보고서는 저장합니다. 실행 중이면 MAINTENANCE_IN_PROGRESS 409입니다.

상태 조회는 UNCERTAIN part 및 만료된 FINALIZING lease를 복구할 수 있습니다. 서버의 실제 확인 전에는 READY를 반환하지 않습니다. complete/cancel 경합에서 완료가 먼저 확정됐다면 취소 요청은 ALREADY_FINALIZING 409입니다.

생성 결과는 주체 + Idempotency-Key에 묶여 10분간 암호화해 보관합니다. 다른 metadata로 같은 키를 쓰면 409입니다. 아직 생성 중이면 CREATE_IN_PROGRESS로 재시도합니다. 이 기간 이후 같은 키의 결과 복구는 지원하지 않습니다. 정상적인 재시도에는 같은 키를 유지하세요.

## 시간과 수명

시간은 Unix epoch millisecond입니다. 새 업로드 권한은 공용 세션 생성 후 900초, 파일 capability는 생성 후 6시간으로 고정됩니다. 완료 시 `completedAt`과 `expiresAt = completedAt + retentionSeconds × 1000`을 한 번만 기록합니다.

다운로드 signed URL TTL은 `min(300초, 파일 잔여 수명, 다운로드 세션 잔여 수명)`입니다. 이미 발급한 R2 URL이나 이미 열린 HTTP 전송을 사후 쿠키 잠금으로 즉시 차단하는 기능은 없습니다.

현재 문서는 수동 계약 설명입니다. machine readable OpenAPI와 스키마 생성은 아직 추가하지 않았습니다.
