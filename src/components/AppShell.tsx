import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { routes } from '../lib/format';
import type { Page } from '../lib/format';
export function AppShell({
  page,
  navigate,
  children,
  local,
  active,
}: {
  page: Page;
  navigate: (page: Page) => void;
  children: ReactNode;
  local?: boolean;
  active: number;
}) {
  const follow = (e: React.MouseEvent<HTMLAnchorElement>, p: Page) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      navigate(p);
    }
  };
  return (
    <div className={`shell${active ? ' has-transfers' : ''}`}>
      <a className="skip-link" href="#main">
        본문으로 이동
      </a>
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => follow(e, 'download')}>
          <span className="mark">
            <Icon name="drop" size={30} />
          </span>
          <strong>
            Temporary Drop<span className="brand-period">.</span>
          </strong>
        </a>
        <nav aria-label="주 메뉴">
          {(['download', 'upload'] as Page[]).map((p) => (
            <a
              key={p}
              href={routes[p]}
              aria-current={page === p ? 'page' : undefined}
              onClick={(e) => follow(e, p)}
            >
              <Icon name={p === 'download' ? 'download' : 'upload'} size={18} />
              {p === 'download' ? '파일 받기' : '파일 올리기'}
            </a>
          ))}
        </nav>
        <a
          className="device-link"
          href="/devices"
          aria-current={page === 'devices' ? 'page' : undefined}
          onClick={(e) => follow(e, 'devices')}
        >
          <Icon name="device" size={18} />내 기기
        </a>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer>
        <span>
          <Icon name="clock" size={16} />
          업로드가 완료된 파일만 표시됩니다. 만료 후에는 새로 받을 수 없습니다.
        </span>
        <span>{local ? '로컬 개발 환경' : 'Temporary Drop'} · 완료 후 1시간에서 3일까지</span>
      </footer>
      {active > 0 && page !== 'upload' && (
        <button className="transfer-strip" onClick={() => navigate('upload')}>
          <span className="transfer-dot" />
          <span>{active}개 파일 전송·확인 중</span>
          <span className="dock-action">
            전송 목록
            <Icon name="arrow" size={18} />
          </span>
        </button>
      )}
    </div>
  );
}
