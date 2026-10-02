import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AuthStatus, DeviceSummary, FileSummary } from '../shared/contracts';
import { POLICY } from '../shared/contracts';
import { api, authStatus, mutate, message, ApiFailure } from './api';
import { engine } from './uploader';
import type { QueueView } from './uploader';
type Page = 'download' | 'upload' | 'devices';
const routes: Record<Page, string> = { download: '/', upload: '/upload', devices: '/devices' };
const pageFromUrl = (): Page =>
  location.pathname === '/devices'
    ? 'devices'
    : location.pathname === '/upload'
      ? 'upload'
      : 'download';
function bytes(n: number) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GiB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' bytes';
}
function left(expires: number, now: number) {
  const secs = Math.max(0, Math.ceil((expires - now) / 1000));
  if (secs >= 3600) return Math.ceil(secs / 3600) + '시간 남음';
  if (secs >= 60) return Math.ceil(secs / 60) + '분 남음';
  return secs + '초 남음';
}
function ago(time: number, now: number) {
  const min = Math.max(0, Math.floor((now - time) / 60_000));
  if (!min) return '방금 완료';
  if (min < 60) return min + '분 전 완료';
  return Math.floor(min / 60) + '시간 전 완료';
}
const retentionText = (n: number) => (n === 259200 ? '3일' : n / 3600 + '시간');
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
function PageHead({
  kicker,
  title,
  body,
  right,
}: {
  kicker: string;
  title: string;
  body: string;
  right?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{kicker}</div>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {right}
    </div>
  );
}
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function TotpForm({
  intent = 'upload',
  onSuccess,
  targetId,
  onBusyChange,
}: {
  intent?: 'upload' | 'manage' | 'create_device' | 'revoke_device' | 'delete_file';
  onSuccess: (grant?: string) => void | Promise<void>;
  targetId?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [code, setCode] = useState(''),
    [trust, setTrust] = useState(false),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const result = await mutate<{ grant?: string }>('/api/auth/totp', {
        code,
        intent: intent === 'upload' && trust ? 'trust' : intent,
        ...(trust && intent === 'upload' ? { deviceName: name } : {}),
        ...(targetId ? { targetId } : {}),
      });
      setCode('');
      await onSuccess(result.grant);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <label className="field">
        Authenticator 코드
        <input
          autoFocus
          className="code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          pattern="[0-9]{6}"
          required
          aria-describedby="totp-help"
        />
      </label>
      {intent === 'upload' && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />내
            개인 기기입니다. 다음부터 인증 없이 업로드합니다.
          </label>
          {trust && (
            <label className="field">
              기기 이름
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 집 Windows"
                required
                maxLength={50}
              />
            </label>
          )}
        </>
      )}
      <p className="help" id="totp-help">
        {intent === 'upload'
          ? trust
            ? '공용 PC에서는 기기를 신뢰하도록 등록하지 마세요.'
            : '이 PC에서는 15분 동안 새 업로드를 시작할 수 있어요.'
          : '이 작업을 위해 새 Authenticator 코드가 필요합니다.'}
      </p>
      <ErrorText error={error} />
      <button
        className={'btn full ' + (intent === 'delete_file' ? 'danger' : 'primary')}
        disabled={busy}
      >
        {busy ? '처리 중…' : intent === 'delete_file' ? '인증하고 영구 삭제' : '인증하고 계속 →'}
      </button>
    </form>
  );
}
export function App() {
  const [page, setPage] = useState<Page>(pageFromUrl),
    [auth, setAuth] = useState<AuthStatus | null>(null),
    [fatal, setFatal] = useState(''),
    [now, setNow] = useState(Date.now()),
    [offset, setOffset] = useState(0),
    [reauth, setReauth] = useState(false),
    [ending, setEnding] = useState(false),
    [endError, setEndError] = useState('');
  const queue = useSyncExternalStore(engine.subscribe, engine.getSnapshot),
    active = queue.filter((i) =>
      ['creating', 'uploading', 'retrying', 'offline', 'finalizing', 'cancel_pending'].includes(
        i.state,
      ),
    ).length;
  const refresh = useCallback(async () => {
    try {
      const result = await authStatus();
      const received = Date.now();
      setAuth(result);
      setNow(received);
      setOffset(result.serverNow - received);
      setFatal('');
      return result;
    } catch (e) {
      setFatal(message(e));
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const pop = () => setPage(pageFromUrl());
    window.addEventListener('popstate', pop);
    const timer = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const focus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.removeEventListener('popstate', pop);
      document.removeEventListener('visibilitychange', focus);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
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
  const navigate = (p: Page) => {
    history.pushState({}, '', routes[p]);
    setPage(p);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const serverNow = now + offset,
    expired =
      auth?.uploadAuth === 'temporary' &&
      !!auth.uploadExpiresAt &&
      auth.uploadExpiresAt <= serverNow;
  const canUpload = !!auth && auth.uploadAuth !== 'none' && !expired;
  const logout = async () => {
    setEndError('');
    try {
      await mutate('/api/auth/logout', { scope: 'all', activeUploads: engine.activeCredentials() });
      engine.stopAfterLogout();
      setEnding(false);
      await refresh();
    } catch (e) {
      setEndError(message(e));
    }
  };
  return (
    <>
      <div className="shell">
        <header className="topbar">
          <a
            className="brand"
            href="/upload"
            onClick={(e) => {
              e.preventDefault();
              navigate('upload');
            }}
          >
            <span className="mark" aria-hidden="true">
              ↓
            </span>
            <span>
              <strong>Temporary Drop</strong>
              <small>PERSONAL FILE TRANSFER</small>
            </span>
          </a>
          <nav aria-label="주 메뉴">
            {(['download', 'upload', 'devices'] as Page[]).map((p, i) => (
              <a
                key={p}
                href={routes[p]}
                aria-current={page === p ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(p);
                }}
              >
                {['파일 받기', '파일 올리기', '내 기기'][i]}
              </a>
            ))}
          </nav>
          <span className="header-note">
            <span className="dot" />
            필요한 동안만, 간편하게
          </span>
        </header>
        {auth?.local && (
          <div className="local-note">
            로컬 개발 환경 · 데이터는 이 컴퓨터의 R2·D1 에뮬레이터에 저장됩니다.
          </div>
        )}
        <main>
          {fatal ? (
            <div className="panel empty">
              <h1>서비스에 연결할 수 없습니다.</h1>
              <ErrorText error={fatal} />
              <button className="btn" onClick={() => void refresh()}>
                다시 연결
              </button>
            </div>
          ) : !auth ? (
            <div className="panel empty" role="status">
              인증 상태를 확인하고 있습니다…
            </div>
          ) : page === 'upload' ? (
            <UploadPage
              auth={auth}
              canUpload={canUpload}
              expired={expired}
              now={serverNow}
              queue={queue}
              refresh={refresh}
              reauth={() => setReauth(true)}
              ending={() => setEnding(true)}
              navigate={navigate}
            />
          ) : page === 'download' ? (
            <DownloadPage auth={auth} now={serverNow} refresh={refresh} navigate={navigate} />
          ) : (
            <DevicesPage auth={auth} refresh={refresh} />
          )}
        </main>
        <footer>
          <span>TEMPORARY DROP</span>
          <span>업로드 완료 후 선택한 기간 동안 보관합니다.</span>
        </footer>
      </div>
      {active > 0 && page !== 'upload' && (
        <button className="transfer-strip" onClick={() => navigate('upload')}>
          {active}개 파일 전송 중 · 업로드로 이동 →
        </button>
      )}
      {reauth && (
        <Dialog title="새 업로드를 시작하려면 인증해 주세요" onClose={() => setReauth(false)}>
          <p>진행 중인 파일은 계속 전송됩니다.</p>
          <TotpForm
            onSuccess={() => {
              setReauth(false);
              void refresh();
            }}
          />
        </Dialog>
      )}
      {ending && (
        <Dialog title="이 PC에서 작업을 마칠까요?" onClose={() => setEnding(false)}>
          <p>진행 중인 업로드가 취소되고 이 PC의 업로드·다운로드 접근이 종료됩니다.</p>
          <ErrorText error={endError} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setEnding(false)}>
              계속 사용
            </button>
            <button className="btn danger" onClick={() => void logout()}>
              취소하고 종료
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function UploadPage({
  auth,
  canUpload,
  expired,
  now,
  queue,
  refresh,
  reauth,
  ending,
  navigate,
}: {
  auth: AuthStatus;
  canUpload: boolean;
  expired: boolean;
  now: number;
  queue: QueueView[];
  refresh: () => Promise<AuthStatus | null>;
  reauth: () => void;
  ending: () => void;
  navigate: (p: Page) => void;
}) {
  const [retention, setRetention] = useState(86400),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false),
    [cancel, setCancel] = useState<QueueView | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const add = (files: File[]) => {
    setError('');
    try {
      engine.add(files, retention);
    } catch (e) {
      setError(message(e));
    }
  };
  const badge =
    auth.uploadAuth === 'trusted' ? (
      <span className="badge">
        <span className="dot" />
        신뢰하는 기기 · {auth.deviceName}
      </span>
    ) : (
      <span className="badge warn">
        ◷ 공용 PC ·{' '}
        {auth.uploadExpiresAt && !expired ? left(auth.uploadExpiresAt, now) : '새 업로드 시간 만료'}
      </span>
    );
  if (auth.uploadAuth === 'none' && !queue.length)
    return (
      <section className="auth-wrap panel">
        <div className="auth-symbol" aria-hidden="true">
          ✳
        </div>
        <h1>파일을 올리려면 인증해 주세요</h1>
        <p className="muted">Google Authenticator의 6자리 코드를 입력하세요.</p>
        <TotpForm onSuccess={() => void refresh()} />
      </section>
    );
  return (
    <>
      <PageHead
        kicker="SEND / UPLOAD"
        title="파일 올리기"
        body="다른 기기에서 받을 파일을 잠시 보관하세요."
        right={badge}
      />
      {!canUpload && (
        <div className="banner warn">
          <div>
            <strong>새 업로드 가능 시간이 끝났습니다.</strong>
            <p>진행 중인 파일은 계속 전송됩니다. 새 파일은 다시 인증한 후 시작할 수 있어요.</p>
          </div>
          <button className="btn" onClick={reauth}>
            다시 인증
          </button>
        </div>
      )}
      {auth.uploadAuth === 'temporary' && canUpload && (
        <div className="banner">
          <div>
            <strong>이 PC에서는 15분 동안 새 업로드를 시작할 수 있어요.</strong>
            <p>시간이 끝나도 진행 중인 파일은 계속 전송됩니다.</p>
          </div>
        </div>
      )}
      <div className="grid">
        <section>
          <div
            className={'dropzone ' + (drag ? 'drag ' : '') + (!canUpload ? 'disabled' : '')}
            onDragOver={(e) => {
              e.preventDefault();
              if (canUpload) setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (canUpload) add([...e.dataTransfer.files]);
            }}
          >
            <div className="upload-symbol" aria-hidden="true">
              ↑
            </div>
            <h2>
              {canUpload ? '파일을 여기에 놓아주세요' : '새 파일을 올리려면 다시 인증해 주세요'}
            </h2>
            <p>파일당 최대 32 GiB · 업로드 완료 후 선택한 기간 동안 보관</p>
            <button
              className="btn primary"
              disabled={!canUpload}
              onClick={() => picker.current?.click()}
            >
              ＋ 파일 선택
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                add([...(e.target.files || [])]);
                e.target.value = '';
              }}
            />
            <label className="retention">
              기본 보관 기간{' '}
              <select value={retention} onChange={(e) => setRetention(Number(e.target.value))}>
                {POLICY.retention.map((v) => (
                  <option key={v} value={v}>
                    {retentionText(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ErrorText error={error} />
          <div className="section-head">
            <h2>전송 목록</h2>
            <span>
              대기 {queue.filter((i) => ['queued', 'needs_auth'].includes(i.state)).length} · 완료{' '}
              {queue.filter((i) => i.state === 'ready').length}
            </span>
          </div>
          <div className="panel queue">
            {queue.length ? (
              queue.map((i) => <UploadItem key={i.key} item={i} cancel={() => setCancel(i)} />)
            ) : (
              <div className="empty">
                <h3>아직 선택한 파일이 없어요.</h3>
                <p>파일을 추가해 전송을 시작하세요.</p>
              </div>
            )}
          </div>
          {queue.some((i) => ['queued', 'needs_auth'].includes(i.state)) && (
            <div className="row-footer">
              <span className="help">파일을 확인한 뒤 업로드를 시작하세요.</span>
              <button className="btn primary" disabled={!canUpload} onClick={() => engine.start()}>
                대기 파일 업로드 시작
              </button>
            </div>
          )}
        </section>
        <aside>
          <div className="panel sidebar-card">
            <div className="eyebrow">A LITTLE ROOM BETWEEN DEVICES</div>
            <h3>
              잠깐 두고,
              <br />
              다른 기기에서 받으세요.
            </h3>
            <p>파일 받기 페이지에서 PIN을 입력하면 완료된 파일을 볼 수 있어요.</p>
            <hr />
            <div className="stat-row">
              <span>기본 보관</span>
              <strong>완료 후 {retentionText(retention)}</strong>
            </div>
            <div className="stat-row">
              <span>웹 파일 크기</span>
              <strong>최대 32 GiB</strong>
            </div>
            <hr />
            <button className="btn full" onClick={() => navigate('download')}>
              파일 받기로 이동 ↗
            </button>
          </div>
          <p className="aside-note">
            <strong>전송 중에는 이 탭을 유지해 주세요.</strong>
            <br />
            브라우저를 닫으면 전송이 멈출 수 있습니다. 연결이 잠깐 끊기는 경우에는 다시 시도할 수
            있어요.
          </p>
          {auth.uploadAuth === 'temporary' && (
            <button className="btn ghost full" onClick={ending}>
              이 PC에서 종료
            </button>
          )}
        </aside>
      </div>
      {cancel && (
        <Dialog title="이 파일의 업로드를 취소할까요?" onClose={() => setCancel(null)}>
          <p>
            <strong>{cancel.name}</strong>
            <br />
            다시 올리려면 처음부터 시작해야 합니다.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setCancel(null)}>
              계속 업로드
            </button>
            <button
              className="btn danger"
              onClick={() => {
                void engine.cancel(cancel.key);
                setCancel(null);
              }}
            >
              업로드 취소
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function UploadItem({ item, cancel }: { item: QueueView; cancel: () => void }) {
  const labels: Record<QueueView['state'], string> = {
    queued: '대기 중',
    needs_auth: '인증 필요',
    creating: '전송 준비 중',
    uploading: '전송 중',
    retrying: '연결 재시도',
    offline: '인터넷 연결 대기',
    finalizing: '파일 확인 중',
    ready: '✓ 업로드 완료',
    cancel_pending: '취소 확인 중',
    cancelled: '취소됨',
    failed: '전송 실패',
  };
  const progressing = ['uploading', 'retrying', 'offline', 'finalizing'].includes(item.state),
    queued = ['queued', 'needs_auth'].includes(item.state);
  return (
    <article className="upload-row">
      <div className="file-top">
        <span className="file-icon" aria-hidden="true">
          {item.name.split('.').at(-1)?.slice(0, 4).toUpperCase() || 'FILE'}
        </span>
        <div className="file-info">
          <strong className="filename">{item.name}</strong>
          <span className="filemeta">
            {bytes(item.size)} · 완료 후 {retentionText(item.retention)} 보관
          </span>
        </div>
        <span className={'status ' + (item.state === 'failed' ? 'danger' : '')}>
          {labels[item.state]}
        </span>
      </div>
      {progressing && (
        <>
          <div
            className="progress"
            role="progressbar"
            aria-label={item.name + ' 전송률'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={item.progress}
          >
            <div style={{ width: item.progress + '%' }} />
          </div>
          <div className="progress-meta">
            <span>
              {bytes(item.bytes)} / {bytes(item.size)} ·{' '}
              {item.speed > 0 ? bytes(item.speed) + '/s' : '속도 계산 중'}
            </span>
            <strong>{item.progress}%</strong>
          </div>
        </>
      )}
      <ErrorText error={item.error || ''} />
      <div className="row-footer">
        {queued ? (
          <label className="help">
            보관 기간{' '}
            <select
              value={item.retention}
              onChange={(e) => engine.changeRetention(item.key, Number(e.target.value))}
            >
              {POLICY.retention.map((v) => (
                <option key={v} value={v}>
                  {retentionText(v)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="help">
            {item.result
              ? '만료: ' + new Date(item.result.expiresAt).toLocaleString()
              : item.state === 'finalizing'
                ? '완료된 파일을 확인하고 있어요.'
                : ''}
          </span>
        )}
        {queued || ['ready', 'cancelled'].includes(item.state) ? (
          <button className="btn small ghost" onClick={() => engine.remove(item.key)}>
            {item.state === 'ready' ? '이 화면에서 지우기' : '목록에서 제거'}
          </button>
        ) : item.state === 'failed' ? (
          <div className="button-row">
            <button className="btn small" onClick={() => void engine.restart(item.key)}>
              새로 시작
            </button>
            <button className="btn small ghost" onClick={cancel}>
              취소 확인
            </button>
          </div>
        ) : (
          !['finalizing', 'cancel_pending'].includes(item.state) && (
            <button className="btn small ghost" onClick={cancel}>
              취소
            </button>
          )
        )}
      </div>
    </article>
  );
}
function DownloadPage({
  auth,
  now,
  refresh,
  navigate,
}: {
  auth: AuthStatus;
  now: number;
  refresh: () => Promise<AuthStatus | null>;
  navigate: (p: Page) => void;
}) {
  const [pin, setPin] = useState(''),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [files, setFiles] = useState<FileSummary[]>([]),
    [deleting, setDeleting] = useState<FileSummary | null>(null),
    [deleteBusy, setDeleteBusy] = useState(false),
    [deleteError, setDeleteError] = useState(''),
    [notice, setNotice] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  const unlocked =
    auth.downloadUnlocked && !!auth.downloadExpiresAt && auth.downloadExpiresAt > now;
  const load = useCallback(
    async (next?: string) => {
      try {
        const result = await api<{ files: FileSummary[]; nextCursor: string | null }>(
          '/api/files' + (next ? '?cursor=' + encodeURIComponent(next) : ''),
        );
        setFiles((old) => (next ? [...old, ...result.files] : result.files));
        setCursor(result.nextCursor);
        setLoaded(true);
        setError('');
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 401) {
          setFiles([]);
          void refresh();
        }
        setError(message(e));
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!unlocked) {
      setFiles([]);
      setLoaded(false);
      return;
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [unlocked, load]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await mutate('/api/download/unlock', { pin, remember });
      setPin('');
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (!unlocked)
    return (
      <section className="auth-wrap panel">
        <div className="auth-symbol" aria-hidden="true">
          ⌑
        </div>
        <h1>파일을 받아보세요</h1>
        <p className="muted">다운로드 PIN을 입력하면 목록을 볼 수 있어요.</p>
        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            다운로드 PIN
            <input
              autoFocus
              className="code"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="••••"
              pattern="[0-9]{4}"
              required
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            내 기기에서만 30일 동안 기억
          </label>
          <p className="help">공용 PC에서는 기억하기를 선택하지 마세요.</p>
          <ErrorText error={error} />
          <button className="btn primary full" disabled={busy}>
            {busy ? 'PIN 확인 중…' : '파일 목록 열기 →'}
          </button>
        </form>
      </section>
    );
  const lock = async () => {
    try {
      await mutate('/api/auth/logout', { scope: 'download' });
      setFiles([]);
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  };
  const deleteFile = async (grant?: string) => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await mutate(
        `/api/files/${deleting.id}`,
        {},
        'DELETE',
        grant ? { 'X-Admin-Grant': grant } : {},
      );
      setFiles((previous) => previous.filter((file) => file.id !== deleting.id));
      setNotice(`${deleting.filename} 파일을 삭제했습니다.`);
      setDeleting(null);
      await load();
    } catch (error) {
      await refresh();
      await load();
      throw error;
    } finally {
      setDeleteBusy(false);
    }
  };
  const visible = files.filter((f) => f.expiresAt > now);
  return (
    <>
      <PageHead
        kicker="RECEIVE / DOWNLOAD"
        title="받을 수 있는 파일"
        body="보관 시간이 끝나면 자동으로 사라집니다."
        right={
          <span className="badge">
            <span className="dot" />
            다운로드 잠금 해제됨
          </span>
        }
      />
      <div className="section-head">
        <span>{visible.length}개 파일 · 최근 완료한 순서</span>
        <div className="button-row">
          <button className="btn small ghost" onClick={() => void load()}>
            ↻ 새로고침
          </button>
          <button className="btn small" onClick={() => void lock()}>
            잠금
          </button>
        </div>
      </div>
      <ErrorText error={error} />
      {notice && <p role="status">{notice}</p>}
      <section className="panel file-table">
        {!loaded ? (
          <div className="empty" role="status">
            파일 목록을 불러오고 있습니다…
          </div>
        ) : !visible.length ? (
          <div className="empty">
            <div className="auth-symbol" aria-hidden="true">
              ↓
            </div>
            <h2>아직 받을 파일이 없어요.</h2>
            <p>다른 기기에서 파일을 올리면 여기에 표시됩니다.</p>
            <button className="btn" onClick={() => navigate('upload')}>
              파일 올리기
            </button>
          </div>
        ) : (
          <>
            <div className="table-head" aria-hidden="true">
              <span>파일 이름</span>
              <span>크기</span>
              <span>보관 시간</span>
              <span />
            </div>
            {visible.map((f) => (
              <article className="download-row" key={f.id}>
                <div className="download-name">
                  <span className="file-icon" aria-hidden="true">
                    {f.filename.split('.').at(-1)?.slice(0, 4).toUpperCase()}
                  </span>
                  <div className="file-info">
                    <strong className="filename">{f.filename}</strong>
                    <span className="filemeta">{ago(f.completedAt, now)}</span>
                  </div>
                </div>
                <span className="download-size">{bytes(f.sizeBytes)}</span>
                <span className={'expiry ' + (f.expiresAt - now < 3600_000 ? 'soon' : '')}>
                  {left(f.expiresAt, now)}
                  <small>{new Date(f.expiresAt).toLocaleString()}</small>
                </span>
                <div className="download-actions">
                  <a
                    className="btn small"
                    href={`/api/files/${f.id}/download`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ↓ 다운로드
                  </a>
                  <button
                    className="btn small danger"
                    aria-label={`${f.filename} 삭제`}
                    onClick={() => {
                      setNotice('');
                      setDeleteError('');
                      setDeleting(f);
                    }}
                  >
                    삭제
                  </button>
                </div>
              </article>
            ))}
          </>
        )}
      </section>
      {deleting && (
        <Dialog
          title="파일을 영구 삭제할까요?"
          onClose={() => {
            if (!deleteBusy) setDeleting(null);
          }}
        >
          <p className="filename">{deleting.filename}</p>
          <p>삭제하면 모든 기기에서 다운로드할 수 없으며 복구할 수 없습니다.</p>
          <ErrorText error={deleteError} />
          {auth.uploadAuth === 'trusted' ? (
            <>
              <p className="help">
                신뢰 기기로 등록된 브라우저이므로 인증 코드 없이 삭제할 수 있습니다.
              </p>
              <button
                className="btn danger full"
                disabled={deleteBusy}
                onClick={() => {
                  void deleteFile().catch((error) => setDeleteError(message(error)));
                }}
              >
                {deleteBusy ? '삭제 중…' : '영구 삭제'}
              </button>
            </>
          ) : (
            <TotpForm
              intent="delete_file"
              targetId={deleting.id}
              onBusyChange={setDeleteBusy}
              onSuccess={deleteFile}
            />
          )}
          <button
            className="btn full"
            style={{ marginTop: 12 }}
            disabled={deleteBusy}
            onClick={() => setDeleting(null)}
          >
            취소
          </button>
        </Dialog>
      )}
      {cursor && (
        <button className="btn load-more" onClick={() => void load(cursor)}>
          더 보기
        </button>
      )}
      <div className="banner" style={{ marginTop: 24 }}>
        <div>
          <strong>공용 PC에서 사용하고 있나요?</strong>
          <p>작업을 마친 뒤 잠금을 눌러 이 브라우저의 다운로드 접근을 종료하세요.</p>
        </div>
      </div>
    </>
  );
}
function DevicesPage({
  auth,
  refresh,
}: {
  auth: AuthStatus;
  refresh: () => Promise<AuthStatus | null>;
}) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null),
    [error, setError] = useState(''),
    [dialog, setDialog] = useState<'shortcut' | DeviceSummary | null>(null),
    [token, setToken] = useState(''),
    [name, setName] = useState('내 iPhone 단축어');
  const load = useCallback(async (grant?: string) => {
    try {
      const result = await api<{ devices: DeviceSummary[] }>('/api/devices', {
        headers: grant ? { 'X-Admin-Grant': grant } : {},
      });
      setDevices(result.devices);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    if (auth.uploadAuth === 'trusted') void load();
  }, [auth.uploadAuth, load]);
  if (!devices && auth.uploadAuth !== 'trusted')
    return (
      <section className="auth-wrap panel">
        <div className="auth-symbol" aria-hidden="true">
          ✳
        </div>
        <h1>내 기기를 관리하세요</h1>
        <p className="muted">관리 인증은 이 브라우저를 신뢰 기기로 등록하지 않습니다.</p>
        <TotpForm intent="manage" onSuccess={(g) => void load(g)} />
        <ErrorText error={error} />
      </section>
    );
  const close = () => {
    setDialog(null);
    setToken('');
  };
  const create = async (grant?: string) => {
    try {
      const result = await mutate<{ id: string; token: string }>(
        '/api/devices',
        { name, kind: 'shortcut' },
        'POST',
        { 'X-Admin-Grant': grant || '' },
      );
      setToken(result.token);
      if (auth.uploadAuth === 'trusted') await load();
      else
        setDevices((old) => [
          {
            id: result.id,
            name,
            kind: 'shortcut',
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            current: false,
          },
          ...(old || []),
        ]);
    } catch (e) {
      setError(message(e));
    }
  };
  const revoke = async (grant?: string) => {
    if (!dialog || dialog === 'shortcut') return;
    try {
      await mutate(`/api/devices/${dialog.id}`, {}, 'DELETE', { 'X-Admin-Grant': grant || '' });
      setDevices((old) => old?.filter((d) => d.id !== dialog.id) || []);
      close();
      await refresh();
      if (dialog.current) setDevices(null);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <PageHead
        kicker="ACCESS / YOUR DEVICES"
        title="내 기기"
        body="등록한 기기는 인증 없이 파일을 올릴 수 있어요."
        right={
          <button
            className="btn primary"
            onClick={() => {
              setError('');
              setDialog('shortcut');
            }}
          >
            ＋ iPhone 단축어 연결
          </button>
        }
      />
      <ErrorText error={error} />
      <div className="section-head">
        <span>{devices?.length || 0}개 등록 기기</span>
      </div>
      <section className="panel">
        {devices ? (
          devices.map((d) => (
            <article className="device-row" key={d.id}>
              <span className="device-icon" aria-hidden="true">
                {d.kind === 'shortcut' ? '▯' : '▱'}
              </span>
              <div className="file-info">
                <strong className="filename">
                  {d.name} {d.current && <span className="tiny-badge">현재 기기</span>}
                </strong>
                <span className="filemeta">
                  {d.kind === 'shortcut' ? '단축어 업로드 전용' : '브라우저 업로드'} ·{' '}
                  {new Date(d.lastUsedAt).toLocaleString()}
                </span>
              </div>
              <button
                className="btn small ghost text-danger"
                onClick={() => {
                  setError('');
                  setDialog(d);
                }}
              >
                권한 해제
              </button>
            </article>
          ))
        ) : (
          <div className="empty">기기 목록을 불러오고 있습니다…</div>
        )}
      </section>
      <div className="panel sidebar-card" style={{ marginTop: 24 }}>
        <h3>기기를 잃어버렸다면 권한을 해제하세요.</h3>
        <p>
          선택한 기기의 새 업로드와 진행 중인 전송 요청이 차단됩니다. 해제하려면 새로운
          Authenticator 코드가 필요합니다.
        </p>
      </div>
      {dialog && (
        <Dialog
          title={
            dialog === 'shortcut'
              ? token
                ? '개인 단축어에 토큰을 입력하세요'
                : 'iPhone 단축어 연결'
              : `${dialog.name}의 권한을 해제할까요?`
          }
          onClose={close}
        >
          {dialog === 'shortcut' ? (
            token ? (
              <>
                <p>
                  이 화면을 닫으면 토큰을 다시 볼 수 없습니다. 단축어를 공유하기 전에 토큰을
                  제거하세요.
                </p>
                <textarea className="token" aria-label="단축어 기기 토큰" readOnly value={token} />
                <div className="dialog-actions">
                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(token)
                        .catch(() => setError('직접 토큰을 선택해 복사해 주세요.'));
                    }}
                  >
                    복사
                  </button>
                  <button className="btn primary" onClick={close}>
                    확인
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="field">
                  기기 이름
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
                </label>
                <p>이 토큰은 파일 업로드 전용입니다. 다른 사람에게 공유하지 마세요.</p>
                <TotpForm intent="create_device" onSuccess={(g) => void create(g)} />
              </>
            )
          ) : (
            <>
              <p>
                새 업로드와 진행 중인 전송 요청이 차단됩니다.
                {dialog.current ? ' 현재 브라우저도 다시 인증해야 합니다.' : ''}
              </p>
              <TotpForm
                intent="revoke_device"
                targetId={dialog.id}
                onSuccess={(g) => void revoke(g)}
              />
            </>
          )}
          <ErrorText error={error} />
        </Dialog>
      )}
    </>
  );
}
