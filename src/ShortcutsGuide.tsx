import type { Page } from './lib/format';

export function ShortcutsGuide({ navigate }: { navigate: (page: Page) => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">IPHONE / SHORTCUTS</div>
          <h1 tabIndex={-1}>아이폰에서 파일 보내기</h1>
          <p>단축어를 설치하면 공유 메뉴에서 파일과 사진을 보낼 수 있습니다.</p>
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
      <section className="shortcut-install" aria-labelledby="shortcut-install-title">
        <h2 id="shortcut-install-title">Temporary Drop 단축어 설치</h2>
        <p>아이폰에서 아래 링크를 열고 단축어를 추가하세요.</p>
        <a
          className="btn secondary"
          href="https://www.icloud.com/shortcuts/f1355a8b8e7b4ae58c6f1d286fe60729"
          target="_blank"
          rel="noopener noreferrer"
        >
          iCloud에서 단축어 열기
        </a>
      </section>
      <section className="shortcut-usage" aria-labelledby="shortcut-usage-title">
        <h2 id="shortcut-usage-title">사용 방법</h2>
        <ol>
          <li>
            <h3>처음 한 번, 토큰 설정</h3>
            <p>
              내 기기 → iPhone 단축어 연결에서 업로드 토큰을 발급하고, 설치한 단축어의 기기 토큰에
              붙여 넣으세요.
            </p>
          </li>
          <li>
            <h3>파일이나 사진 보내기</h3>
            <p>파일 또는 사진을 선택하고 공유 메뉴에서 Temporary Drop을 실행하세요.</p>
          </li>
          <li>
            <h3>다른 기기에서 받기</h3>
            <p>전송이 끝나면 다른 기기에서 이 사이트의 파일 받기를 열어 다운로드하세요.</p>
          </li>
        </ol>
        <p className="shortcut-usage-note">
          첫 사용은 작은 파일로 시험하세요. 전송이 끝날 때까지 단축어를 열어두고, 개인 토큰을 넣은
          단축어는 공유하지 마세요.
        </p>
      </section>
    </>
  );
}
