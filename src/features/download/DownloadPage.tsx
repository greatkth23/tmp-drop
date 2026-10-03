import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthStatus, FileSummary } from '../../../shared/contracts';
import { ApiFailure, message, mutate } from '../../api';
import { engine } from '../../uploader';
import { Icon } from '../../components/Icon';
import { ErrorText, FileIdentity, PageHead } from '../../components/Ui';
import { useNow } from '../../hooks/useAuthStatus';
import { ago, bytes, dateTime, left } from '../../lib/format';
import type { Page } from '../../lib/format';
import { DeleteFileDialog } from './DeleteFileDialog';
import { readFilePages } from './listing';
export function DownloadPage({
  auth,
  offset,
  refresh,
  navigate,
  ending,
  connected,
}: {
  auth: AuthStatus;
  offset: number;
  refresh: () => Promise<AuthStatus | null>;
  navigate: (page: Page) => void;
  ending: () => void;
  connected: boolean;
}) {
  const now = useNow(offset),
    id = useId();
  const unlocked =
    auth.downloadUnlocked && !!auth.downloadExpiresAt && auth.downloadExpiresAt > now;
  const [pin, setPin] = useState(''),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [files, setFiles] = useState<FileSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [lastChecked, setLastChecked] = useState(0),
    [deleting, setDeleting] = useState<FileSummary | null>(null),
    [notice, setNotice] = useState(''),
    [retryAt, setRetryAt] = useState(0);
  const pages = useRef(1),
    generation = useRef(0),
    request = useRef<AbortController | null>(null),
    pinInput = useRef<HTMLInputElement>(null);
  const load = useCallback(
    async (more = false, force = false) => {
      if (request.current && !force) return;
      request.current?.abort();
      const controller = new AbortController(),
        current = ++generation.current;
      request.current = controller;
      setLoading(true);
      try {
        const target = pages.current + (more ? 1 : 0);
        const result = await readFilePages(target, controller.signal);
        if (current !== generation.current) return;
        setFiles(result.files);
        setCursor(result.nextCursor);
        pages.current = target;
        setLoaded(true);
        setLastChecked(Date.now());
        setError('');
      } catch (e) {
        if (current !== generation.current) return;
        if (e instanceof ApiFailure && e.status === 401) {
          setFiles([]);
          setLoaded(false);
          setDeleting(null);
          await refresh();
        }
        setError(message(e));
      } finally {
        if (current === generation.current) {
          request.current = null;
          setLoading(false);
        }
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!unlocked) {
      generation.current++;
      request.current?.abort();
      request.current = null;
      pages.current = 1;
      setFiles([]);
      setCursor(null);
      setLoaded(false);
      setLoading(false);
      setDeleting(null);
      return;
    }
    void load();
    const update = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      generation.current++;
      request.current?.abort();
      request.current = null;
    };
  }, [unlocked, load]);
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || seconds) return;
    setBusy(true);
    setError('');
    try {
      await mutate('/api/download/unlock', { pin, remember });
      setPin('');
      setNotice('');
      await refresh();
    } catch (e) {
      setError(message(e));
      pinInput.current?.select();
      if (e instanceof ApiFailure && e.retryAfterSeconds)
        setRetryAt(Date.now() + e.retryAfterSeconds * 1000);
    } finally {
      setBusy(false);
    }
  };
  const lock = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutate('/api/auth/logout', { scope: 'download' });
      generation.current++;
      request.current?.abort();
      setFiles([]);
      await refresh();
      setNotice('이 브라우저의 파일 받기 접근을 잠갔습니다.');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const visible = files.filter((f) => f.expiresAt > now);
  return (
    <>
      <PageHead
        title={unlocked ? '받을 수 있는 파일' : '파일 받기'}
        body={
          unlocked
            ? '보관 시간이 끝나기 전에 받아주세요.'
            : '다른 기기에서 올린 파일을 여기서 받으세요.'
        }
      />
      {!unlocked ? (
        <section className="auth-wrap panel">
          <span className="auth-symbol">
            <Icon name="lock" size={28} />
          </span>
          <h2>PIN으로 목록을 열어주세요.</h2>
          <p className="muted">파일 받기에 사용할 4자리 PIN을 입력하세요.</p>
          <form onSubmit={(e) => void submit(e)} aria-busy={busy}>
            <label className="field">
              다운로드 PIN
              <input
                ref={pinInput}
                className="code"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                pattern="[0-9]{4}"
                required
                disabled={busy}
                aria-invalid={!!error}
                aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={busy}
              />
              <span>내 기기에서 30일 동안 기억</span>
            </label>
            <p className="help" id={`${id}-help`}>
              공용 PC에서는 기억하기를 선택하지 마세요.
            </p>
            <ErrorText error={error} id={`${id}-error`} />
            <button className="btn primary full" disabled={busy || seconds > 0 || !connected}>
              {busy ? 'PIN 확인 중…' : seconds ? `${seconds}초 후 다시 시도` : '파일 목록 열기'}
              <Icon name="arrow" />
            </button>
          </form>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <div className="auth-foot">
            <Icon name="lock" size={16} />
            PIN을 확인하기 전에는 파일이 표시되지 않습니다.
          </div>
        </section>
      ) : (
        <>
          <div className="access-bar">
            <div className="access-detail">
              <span className="access-icon">
                <Icon name="lock" />
              </span>
              <div>
                <strong>파일 받기 접근이 열려 있어요.</strong>
                <span>다른 사람이 쓰는 PC라면 작업 후 잠가주세요.</span>
              </div>
            </div>
            <div className="button-row">
              <button className="btn secondary small" disabled={busy} onClick={() => void lock()}>
                <Icon name="lock" size={16} />
                다운로드 잠금
              </button>
              {auth.uploadAuth === 'temporary' && (
                <button className="btn quiet small" onClick={ending}>
                  이 브라우저에서 종료
                </button>
              )}
            </div>
          </div>
          <div className="section-head">
            <div>
              <strong>
                불러온 파일 <span className="count">{visible.length}</span>
              </strong>
              <span className="list-meta">
                최근 완료순{lastChecked > 0 && ` · ${dateTime(lastChecked)} 확인`}
              </span>
            </div>
            <button className="btn quiet small" disabled={loading} onClick={() => void load()}>
              <Icon name="refresh" size={18} />
              {loading ? '확인 중…' : '새로고침'}
            </button>
          </div>
          <ErrorText error={error} />
          {notice && (
            <p className="notice" role="status">
              <Icon name="check" size={18} />
              {notice}
            </p>
          )}
          <section
            className="panel file-table"
            aria-label="받을 수 있는 파일 목록"
            aria-busy={loading}
          >
            {!loaded ? (
              <div className="empty">
                <Icon name={error ? 'warning' : 'refresh'} size={28} />
                <h2>{error ? '목록을 불러오지 못했어요.' : '파일을 확인하고 있어요.'}</h2>
                {error && (
                  <button className="btn secondary" onClick={() => void load()}>
                    다시 불러오기
                  </button>
                )}
              </div>
            ) : !visible.length ? (
              <div className="empty">
                <span className="empty-symbol">
                  <Icon name="download" size={32} />
                </span>
                <h2>
                  {files.length ? '보관 중인 파일이 모두 만료됐어요.' : '아직 받을 파일이 없어요.'}
                </h2>
                <p>다른 기기에서 파일을 올리면 여기에 표시됩니다.</p>
                <button className="btn secondary" onClick={() => navigate('upload')}>
                  파일 올리기
                  <Icon name="arrow" />
                </button>
              </div>
            ) : (
              <>
                <div className="table-head" aria-hidden="true">
                  <span>파일</span>
                  <span>크기</span>
                  <span>보관 시간</span>
                  <span>받기 · 정리</span>
                </div>
                {visible.map((f) => (
                  <article className="download-row" key={f.id}>
                    <FileIdentity name={f.filename} detail={ago(f.completedAt, now)} />
                    <span className="download-size">{bytes(f.sizeBytes)}</span>
                    <div className={`expiry ${f.expiresAt - now < 3600_000 ? 'soon' : ''}`}>
                      <span>
                        <Icon name="clock" size={14} />
                        {left(f.expiresAt, now)}
                      </span>
                      <small>{dateTime(f.expiresAt)}</small>
                    </div>
                    <div className="download-actions">
                      <a
                        className="btn primary small"
                        href={`/api/files/${f.id}/download`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${f.filename} 다운로드`}
                      >
                        <Icon name="download" size={18} />
                        다운로드
                      </a>
                      <button
                        className="btn quiet small danger-text"
                        disabled={!connected}
                        aria-label={`${f.filename} 삭제`}
                        onClick={() => {
                          setNotice('');
                          setDeleting(f);
                        }}
                      >
                        <Icon name="trash" size={17} />
                        삭제
                      </button>
                    </div>
                  </article>
                ))}
              </>
            )}
          </section>
          {cursor && (
            <button
              className="btn secondary load-more"
              disabled={loading}
              onClick={() => void load(true)}
            >
              {loading ? '불러오는 중…' : '더 보기'}
              <Icon name="plus" size={18} />
            </button>
          )}
          <p className="list-foot">
            <Icon name="clock" size={16} />
            업로드가 완료된 파일만 표시됩니다. 만료 후에는 새로 받을 수 없습니다.
          </p>
        </>
      )}
      {deleting && (
        <DeleteFileDialog
          file={deleting}
          auth={auth}
          refresh={refresh}
          connected={connected}
          onClose={() => setDeleting(null)}
          onReconcile={() => load(false, true)}
          onDeleted={() => {
            const target = deleting;
            engine.markDeleted(target.id);
            setFiles((old) => old.filter((f) => f.id !== target.id));
            setNotice(`${target.filename} 파일을 삭제했습니다.`);
            setDeleting(null);
            void load(false, true);
          }}
        />
      )}
    </>
  );
}
