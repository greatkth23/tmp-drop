import { useState } from 'react';
import type { Page } from './lib/format';

const steps = [
  [
    '공유 메뉴에서 실행하기',
    '단축어 앱에서 새 단축어를 만들고 이름을 Temporary Drop으로 지정하세요. 세부사항에서 공유 시트에 표시를 켜고 파일과 이미지를 입력 유형으로 선택하세요. 첫 시험은 파일 앱의 작은 텍스트 파일 하나로 진행하세요.',
  ],
  [
    '개인 토큰 설정하기',
    '내 기기 → iPhone 단축어 연결에서 토큰을 발급하세요. 단축어 맨 위에 텍스트 액션을 추가하고 토큰을 붙여 넣은 뒤, 변수 이름을 기기 토큰으로 지정하세요. 이 값은 업로드 전용이며 PIN이나 Authenticator 코드가 아닙니다.',
  ],
  [
    '파일 변수 준비하기',
    '공유 입력을 전송 파일 변수로 지정하세요. 파일의 세부사항 가져오기에서 이름과 파일 크기를 각각 읽어 파일명과 바이트 크기로 저장하세요. 파일 크기는 숫자 변수로 사용해야 하며 MB 등 표시 문자열을 JSON에 넣으면 안 됩니다. 파일 여러 개를 처리할 때는 각 항목 반복하기 안에서 이 과정을 진행하세요.',
  ],
  [
    '요청 식별자 만들기',
    '1~2147483647 범위의 임의의 숫자를 세 번 만들고 텍스트 액션에서 ios-숫자1-숫자2-숫자3으로 연결하세요. 요청 키 변수로 저장하고 같은 생성 요청을 재시도할 때는 이 값을 유지하세요.',
  ],
  [
    '업로드 생성하기',
    'URL 콘텐츠 가져오기를 POST로 설정하세요. 아래 주소·헤더·JSON 필드를 넣고 결과를 생성 응답 변수로 저장하세요. filename에는 파일명, sizeBytes에는 숫자인 바이트 크기를 연결합니다. 응답에 error가 있으면 message를 표시하고 단축어를 중단하세요.',
  ],
  [
    '원본 파일 전송하기',
    '사전 값 가져오기를 세 번 사용해 생성 응답의 id, capability, putUrl을 각각 저장하세요. putUrl을 URL 콘텐츠 가져오기의 주소로 사용하고 PUT → 요청 본문: 파일 → 전송 파일을 선택하세요. JSON이나 폼으로 감싸지 마세요. 운영 PUT 헤더는 현재 비어 있으며 기기 토큰과 capability를 이 요청에 넣지 않습니다.',
  ],
  [
    '업로드 확정하기',
    '아래 완료 주소를 텍스트 액션으로 만들되 {id}에는 생성 응답에서 받은 id 변수를 연결하세요. URL 콘텐츠 가져오기를 POST로 설정하고 Authorization에는 Upload와 capability를 공백으로 연결하세요. 요청 본문은 필드가 없는 JSON입니다. 응답의 state를 읽으세요.',
  ],
  [
    '완료 상태 확인하기',
    '만약 state가 READY이면 완료 알림을 표시하세요. FINALIZING이면 3초 대기 후 아래 상태 주소로 GET 요청을 보내고 state를 다시 읽으세요. Authorization은 완료 요청과 같습니다. 최대 20번 확인해도 READY가 아니면 현재 상태를 표시하고 중단하세요. 오류나 그 외 상태에서는 완료 알림을 표시하지 마세요.',
  ],
];

function Example({ label, value }: { label: string; value: string }) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="shortcut-example">
      <div className="section-head">
        <strong>{label}</strong>
        <button
          className="btn small"
          onClick={() => {
            setFeedback('');
            void navigator.clipboard
              .writeText(value)
              .then(() => setFeedback('복사했습니다.'))
              .catch(() => setFeedback('아래 내용을 직접 선택해 복사해 주세요.'));
          }}
        >
          {label} 복사
        </button>
      </div>
      <pre>{value}</pre>
      {feedback && (
        <p className="help" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}

export function ShortcutsGuide({ navigate }: { navigate: (page: Page) => void }) {
  const origin = location.origin;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">IPHONE / SHORTCUTS</div>
          <h1 tabIndex={-1}>아이폰에서 파일 보내기</h1>
          <p>iOS 27.0.1에서 직접 만들 단축어의 설정 순서입니다.</p>
        </div>
        <a
          className="btn primary"
          href="/devices"
          onClick={(e) => {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
              e.preventDefault();
              navigate('devices');
            }
          }}
        >
          업로드 토큰 발급하기
        </a>
      </div>
      <div className="banner">
        <div>
          <strong>현재는 직접 제작하는 방식입니다.</strong>
          <p>
            설치용 단축어 파일은 아직 제공하지 않습니다. 기존 단축어의 아이폰 업로드는 확인했습니다.
            묶음 ID를 추가한 버전은 아이폰에서 다시 확인해 주세요. 먼저 작은 파일로 시험하고 전송이
            끝날 때까지 단축어를 화면에 유지하세요.
          </p>
        </div>
      </div>
      <section className="panel sidebar-card shortcut-guide">
        <h2>한 번에 보낸 파일을 묶음으로 표시하기</h2>
        <p>
          기존 단축어의 각 항목 반복하기 바로 위에 임의의 숫자 액션 3개(1~2147483647)를 추가하세요.
          텍스트 액션에서 batch-숫자1-숫자2-숫자3으로 연결하고 묶음 ID 변수로 저장합니다.
        </p>
        <p>
          생성 POST의 JSON에 batchKey 필드를 텍스트 유형으로 추가하고 묶음 ID를 연결하세요. 한 번
          실행할 때 모든 파일이 같은 묶음 ID를 사용해야 합니다. 기존 파일별 요청 키는 그대로
          유지합니다.
        </p>
        <p>
          이 설정을 추가한 뒤 업로드한 파일부터 묶음으로 표시됩니다. 기존 파일은 개별 항목으로
          표시됩니다.
        </p>
      </section>
      <section className="panel sidebar-card shortcut-guide">
        <h2>단축어 액션 설정</h2>
        <p>
          변수는 단축어 편집기에서 선택해 연결하세요. 아래의 중괄호 이름을 주소에 그대로 넣지
          마세요.
        </p>
        <ol>
          {steps.map(([title, body], index) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
              {index === 4 && (
                <>
                  <Example label="생성 주소" value={`${origin}/api/shortcut/uploads`} />
                  <Example
                    label="생성 헤더"
                    value={
                      'Authorization: Bearer {기기 토큰}\nIdempotency-Key: {요청 키}\nContent-Type: application/json'
                    }
                  />
                  <Example
                    label="JSON 필드"
                    value={
                      'filename: 텍스트 → 파일명 변수\nsizeBytes: 숫자 → 바이트 크기 변수\nmime: 텍스트 → application/octet-stream\nretentionSeconds: 숫자 → 21600\nbatchKey: 텍스트 → 묶음 ID 변수'
                    }
                  />
                </>
              )}
              {index === 6 && (
                <>
                  <Example label="완료 주소" value={`${origin}/api/uploads/{id}/complete`} />
                  <Example
                    label="완료 헤더"
                    value={'Authorization: Upload {capability}\nContent-Type: application/json'}
                  />
                </>
              )}
              {index === 7 && <Example label="상태 주소" value={`${origin}/api/uploads/{id}`} />}
            </li>
          ))}
        </ol>
      </section>
      <section className="panel sidebar-card shortcut-guide">
        <h2>첫 실행에서 확인할 것</h2>
        <ul>
          <li>파일 앱에서 1 KiB 정도의 텍스트 파일 하나를 선택하고 공유 메뉴로 실행하세요.</li>
          <li>
            완료 알림 뒤 파일 받기에서 같은 이름·크기로 표시되는지 확인하고 내려받아 내용을
            비교하세요.
          </li>
          <li>
            사진 입력은 iOS 공유 과정에서 변환될 수 있습니다. 원본이 필요하면 파일 앱에 저장한
            파일부터 시험하세요.
          </li>
          <li>
            새 설정의 기본 보관은 6시간입니다. 기존 단축어는 retentionSeconds를 21600으로
            변경하세요. retentionSeconds는 3600(1시간), 21600(6시간), 86400(24시간), 259200(3일) 중
            선택하세요.
          </li>
          <li>
            5 GiB는 API 설정 상한이며 아이폰에서 검증한 크기가 아닙니다. 잠금·앱 전환 중 전송은
            보장하지 않습니다.
          </li>
          <li>
            개인 토큰이 들어간 단축어는 공유하지 마세요. iCloud 동기화나 백업에도 토큰이 포함될 수
            있습니다. 토큰을 잃어버리면 내 기기에서 권한을 해제한 뒤 다시 발급하세요.
          </li>
        </ul>
        <h3>실패했을 때</h3>
        <p>
          SIZE_MISMATCH는 선언한 크기와 전송된 파일이 다르다는 뜻입니다. 파일 크기의 숫자 변환과
          PUT에 연결한 파일을 확인하세요. INVALID_INPUT이면 JSON 필드의 숫자·텍스트 유형을
          확인하세요. DEVICE_REVOKED 또는 UNAUTHORIZED이면 기기 토큰을 다시 발급하세요.
        </p>
        <p>
          전송 도중 네트워크 오류가 나면 완료 알림을 표시하지 않습니다. 파일 받기에서 결과를 확인한
          뒤 다시 실행하세요. 새 실행은 새 요청이므로 이전 미완료 파일은 만료 후 정리됩니다.
        </p>
        <a
          href="https://support.apple.com/en-in/guide/shortcuts/apd58d46713f/ios"
          target="_blank"
          rel="noreferrer"
        >
          Apple의 URL 요청·파일 본문 안내
        </a>
      </section>
    </>
  );
}
