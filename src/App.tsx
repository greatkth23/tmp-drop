import { deletionJobs } from './features/download/deletionJobs';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppShell } from './components/AppShell';
import { Dialog, ErrorText } from './components/Ui';
import { useAuthStatus } from './hooks/useAuthStatus';
import { pageFromUrl, routes } from './lib/format';
import type { Page } from './lib/format';
import { engine } from './uploader';
import { message, mutate } from './api';
import { UploadPage } from './features/upload/UploadPage';
import { DownloadPage } from './features/download/DownloadPage';
import { DevicesPage } from './features/devices/DevicesPage';
import { ShortcutsGuide } from './ShortcutsGuide';
export function App() {
  const [page, setPage] = useState<Page>(pageFromUrl),
    [ending, setEnding] = useState(false),
    [endBusy, setEndBusy] = useState(false),
    [endError, setEndError] = useState('');
  const { auth, error, refresh, offset } = useAuthStatus();
  const deletions = useSyncExternalStore(deletionJobs.subscribe, deletionJobs.getSnapshot);
  const queue = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const active = queue.filter((i) =>
    ['creating', 'uploading', 'retrying', 'offline', 'finalizing', 'cancel_pending'].includes(
      i.state,
    ),
  ).length;
  useEffect(() => {
    const pop = () => setPage(pageFromUrl());
    const drop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('dragover', drop);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('dragover', drop);
      window.removeEventListener('drop', drop);
    };
  }, []);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (active) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [active]);
  useEffect(() => {
    document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
  }, [page]);
  const navigate = (p: Page) => {
    if (p !== page) history.pushState({}, '', routes[p]);
    setPage(p);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const logout = async () => {
    if (endBusy) return;
    setEndBusy(true);
    setEndError('');
    try {
      await mutate('/api/auth/logout', { scope: 'all', activeUploads: engine.activeCredentials() });
      engine.stopAfterLogout();
      setEnding(false);
      await refresh();
    } catch (e) {
      setEndError(message(e));
    } finally {
      setEndBusy(false);
    }
  };
  return (
    <AppShell page={page} navigate={navigate} local={auth?.local} active={active}>
      {deletions.length > 0 && (
        <aside className="deletion-notices" aria-label="파일 삭제 작업">
          {deletions.map((job) => (
            <div className="deletion-notice" key={job.key}>
              <div role={job.error ? 'alert' : 'status'}>
                {job.text && <p>{job.text}</p>}
                {job.error && <p className="danger-text">{job.error}</p>}
              </div>
              {!job.pending && (
                <button
                  className="btn quiet small"
                  aria-label="삭제 알림 닫기"
                  onClick={() => deletionJobs.dismiss(job.key)}
                >
                  닫기
                </button>
              )}
            </div>
          ))}
        </aside>
      )}
      {!auth ? (
        <div className="panel connection-state">
          <h1 tabIndex={-1}>{error ? '연결을 확인해 주세요.' : '잠시만 기다려 주세요.'}</h1>
          <p>{error || '이 브라우저의 접근 상태를 확인하고 있습니다.'}</p>
          {error && (
            <button className="btn primary" onClick={() => void refresh()}>
              다시 연결
            </button>
          )}
        </div>
      ) : (
        <>
          {error && (
            <div className="connection-warning">
              <ErrorText error={`접근 상태를 갱신하지 못했습니다. ${error}`} />
              <button className="btn secondary small" onClick={() => void refresh()}>
                다시 연결
              </button>
            </div>
          )}
          {page === 'upload' ? (
            <UploadPage
              auth={auth}
              queue={queue}
              refresh={refresh}
              offset={offset}
              ending={() => {
                setEndError('');
                setEnding(true);
              }}
              navigate={navigate}
              connected={!error}
            />
          ) : page === 'download' ? (
            <DownloadPage
              auth={auth}
              offset={offset}
              refresh={refresh}
              navigate={navigate}
              ending={() => {
                setEndError('');
                setEnding(true);
              }}
              connected={!error}
            />
          ) : page === 'shortcuts' ? (
            <ShortcutsGuide navigate={navigate} />
          ) : (
            <DevicesPage auth={auth} refresh={refresh} navigate={navigate} />
          )}
        </>
      )}
      {ending && (
        <Dialog
          title="이 브라우저에서 작업을 마칠까요?"
          onClose={() => setEnding(false)}
          busy={endBusy}
        >
          <p>
            임시 업로드 접근과 파일 받기 접근을 종료합니다. 취소 가능한 진행 중 전송은 중단됩니다.
          </p>
          {queue.some((i) => i.state === 'finalizing') && (
            <p className="warning-text">파일 확인 단계에 들어간 전송은 완료될 수 있습니다.</p>
          )}
          <ErrorText error={endError} />
          <div className="dialog-actions">
            <button className="btn secondary" disabled={endBusy} onClick={() => setEnding(false)}>
              계속 사용
            </button>
            <button className="btn danger" disabled={endBusy} onClick={() => void logout()}>
              {endBusy ? '종료 중…' : '접근 종료'}
            </button>
          </div>
        </Dialog>
      )}
    </AppShell>
  );
}
