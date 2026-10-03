import { useRef, useState } from 'react';
import type { AuthStatus } from '../../../shared/contracts';
import { POLICY } from '../../../shared/contracts';
import { message } from '../../api';
import { engine, isTransferHistory } from '../../uploader';
import type { QueueState, QueueView } from '../../uploader';
import { useNow } from '../../hooks/useAuthStatus';
import { bytes, countdown, dateTime, retentionText } from '../../lib/format';
import { Dialog, ErrorText, FileIdentity, PageHead } from '../../components/Ui';
import { Icon } from '../../components/Icon';
import { TotpForm } from '../auth/AuthForms';
import type { Page } from '../../lib/format';
export function UploadPage({
  auth,
  queue,
  refresh,
  offset,
  ending,
  navigate,
  connected,
}: {
  auth: AuthStatus;
  queue: QueueView[];
  refresh: () => Promise<AuthStatus | null>;
  offset: number;
  ending: () => void;
  navigate: (page: Page) => void;
  connected: boolean;
}) {
  const now = useNow(offset),
    expired =
      auth.uploadAuth === 'temporary' && !!auth.uploadExpiresAt && auth.uploadExpiresAt <= now;
  const canUpload = connected && auth.uploadAuth !== 'none' && !expired;
  const [retention, setRetention] = useState(21600),
    [view, setView] = useState<'current' | 'history'>('current'),
    [clearHistory, setClearHistory] = useState(false),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false),
    [cancel, setCancel] = useState<QueueView | null>(null),
    [reauth, setReauth] = useState(false),
    [reauthBusy, setReauthBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const pending = queue.filter(
    (i) => ['queued', 'needs_auth'].includes(i.state) && (!i.approved || i.state === 'needs_auth'),
  );
  const active = queue.filter(
    (i) => !['queued', 'needs_auth', 'ready', 'cancelled', 'failed'].includes(i.state),
  );
  const current = queue.filter((i) => !isTransferHistory(i));
  const history = queue.filter(isTransferHistory).slice().reverse();
  const shown = view === 'current' ? current : history;
  const add = (files: File[]) => {
    if (!canUpload) return;
    setError('');
    try {
      engine.add(files, retention);
      setView('current');
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <PageHead title="파일 올리기" body="잠시 올려두고, 다른 기기에서 받으세요." />
      {auth.uploadAuth === 'none' && !queue.length ? (
        <section className="auth-wrap panel">
          <span className="auth-symbol">
            <Icon name="upload" size={28} />
          </span>
          <h2>올리려면 인증해 주세요.</h2>
          <p className="muted">Authenticator의 6자리 코드를 입력하세요.</p>
          <TotpForm
            disabled={!connected}
            onSuccess={async () => {
              await refresh();
            }}
          />
          <div className="auth-foot">
            <Icon name="clock" size={16} />
            보관 시간은 업로드가 끝난 뒤 시작됩니다.
          </div>
        </section>
      ) : (
        <>
          <div className={`access-bar ${!canUpload ? 'warning' : ''}`}>
            <div className="access-detail">
              <span className="access-icon">
                <Icon name={auth.uploadAuth === 'trusted' ? 'device' : 'clock'} />
              </span>
              <div>
                <strong>
                  {auth.uploadAuth === 'trusted'
                    ? auth.deviceName || '신뢰하는 브라우저'
                    : '임시 업로드 접근'}
                </strong>
                <span>
                  {auth.uploadAuth === 'trusted' ? (
                    '이 브라우저에서는 인증 없이 올릴 수 있어요.'
                  ) : !canUpload ? (
                    '새 파일을 시작하려면 다시 인증해 주세요.'
                  ) : (
                    <>
                      새 파일 시작 가능{' '}
                      <b className="numeric">{countdown(auth.uploadExpiresAt!, now)}</b> · 진행 중인
                      파일은 시간이 끝나도 계속 전송됩니다.
                    </>
                  )}
                </span>
              </div>
            </div>
            <div className="button-row">
              {!canUpload && (
                <button
                  className="btn primary small"
                  disabled={!connected}
                  onClick={() => setReauth(true)}
                >
                  다시 인증
                </button>
              )}
              {auth.uploadAuth === 'temporary' && (
                <button className="btn quiet small" onClick={ending}>
                  이 브라우저에서 종료
                  <Icon name="arrow" size={16} />
                </button>
              )}
              {auth.uploadAuth === 'trusted' && (
                <button className="btn quiet small" onClick={() => navigate('devices')}>
                  권한 관리
                  <Icon name="arrow" size={16} />
                </button>
              )}
            </div>
          </div>

          <section
            className={`upload-composer ${drag ? 'drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (canUpload) setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              add([...e.dataTransfer.files]);
            }}
          >
            <div className="upload-toolbar">
              <div className="composer-controls">
                <button
                  className="btn secondary"
                  disabled={!canUpload}
                  onClick={() => picker.current?.click()}
                >
                  <Icon name="plus" />
                  파일 추가
                </button>
                <label className="retention">
                  새 파일 보관
                  <select value={retention} onChange={(e) => setRetention(Number(e.target.value))}>
                    {POLICY.retention.map((v) => (
                      <option key={v} value={v}>
                        {retentionText(v)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {pending.length > 0 && (
                <div className="upload-start">
                  <span className="upload-total">
                    {pending.length}개 · {bytes(pending.reduce((sum, i) => sum + i.size, 0))}
                  </span>
                  <button
                    className="btn primary"
                    disabled={!canUpload}
                    onClick={() => engine.start(pending.map((i) => i.key))}
                  >
                    {pending.length}개 파일 업로드 시작 <Icon name="arrow" />
                  </button>
                </div>
              )}
            </div>
            <p className="composer-help">
              파일당 최대 {bytes(auth.limits.webMax)} · 보관 시간은 업로드 완료 후 시작됩니다.
            </p>
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
          </section>
          <ErrorText error={error} />
          <div className="transfer-heading">
            <div className="transfer-views" role="group" aria-label="전송 목록 보기">
              <button
                className="transfer-view"
                aria-pressed={view === 'current'}
                onClick={() => setView('current')}
              >
                현재 업로드 <span className="count">{current.length}</span>
              </button>
              <button
                className="transfer-view"
                aria-pressed={view === 'history'}
                onClick={() => setView('history')}
              >
                전송 내역 <span className="count">{history.length}</span>
              </button>
            </div>
            {view === 'history' && history.length > 0 && (
              <button className="btn quiet small" onClick={() => setClearHistory(true)}>
                내역 비우기
              </button>
            )}
          </div>
          {view === 'history' && (
            <p className="transfer-scope">
              이 탭에서 완료·취소한 전송입니다. 새로고침하면 초기화되며, 내역을 비워도 보관 중인
              파일은 삭제되지 않습니다.
            </p>
          )}
          <section
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              add([...e.dataTransfer.files]);
            }}
            className="queue transfer-list"
            aria-label={view === 'current' ? '현재 업로드' : '전송 내역'}
          >
            {shown.map((i) => (
              <UploadItem
                key={i.key}
                item={i}
                cancel={() => setCancel(i)}
                reauth={() => setReauth(true)}
                receive={() => navigate('download')}
              />
            ))}
            {!shown.length && (
              <div className="transfer-empty">
                <Icon name={view === 'history' ? 'clock' : 'upload'} size={28} />
                <div>
                  <strong>
                    {view === 'history'
                      ? '전송 내역이 없습니다.'
                      : '추가한 파일이 여기에 표시됩니다.'}
                  </strong>
                  <p>
                    {view === 'history'
                      ? '완료되거나 취소된 파일을 여기서 확인할 수 있습니다.'
                      : '위에서 파일을 추가하거나 이 영역에 끌어 놓으세요.'}
                  </p>
                </div>
              </div>
            )}
          </section>
          {active.length > 0 && (
            <p className="transfer-help">
              <Icon name="warning" size={16} />
              전송 중에는 이 탭을 유지해 주세요. 새로고침하거나 닫으면 이어 올릴 수 없습니다.
            </p>
          )}
        </>
      )}
      {clearHistory && (
        <Dialog title="전송 내역을 비울까요?" onClose={() => setClearHistory(false)}>
          <p>
            이 탭의 완료·취소 내역 {history.length}개를 비웁니다. 업로드 중인 파일과 서버에 보관
            중인 파일은 유지됩니다.
          </p>
          <div className="dialog-actions">
            <button className="btn secondary" onClick={() => setClearHistory(false)}>
              취소
            </button>
            <button
              className="btn primary"
              onClick={() => {
                engine.clearHistory();
                setClearHistory(false);
              }}
            >
              내역 비우기
            </button>
          </div>
        </Dialog>
      )}
      {reauth && (
        <Dialog
          title="새 업로드를 위해 인증해 주세요"
          onClose={() => setReauth(false)}
          initialFocus="input"
          busy={reauthBusy}
        >
          <p>이미 진행 중인 파일은 계속 전송됩니다. 인증 후 대기 파일을 확인하고 시작하세요.</p>
          <TotpForm
            onBusyChange={setReauthBusy}
            disabled={!connected}
            onSuccess={async () => {
              await refresh();
              setReauth(false);
            }}
          />
        </Dialog>
      )}
      {cancel && (
        <Dialog title="이 파일의 업로드를 취소할까요?" onClose={() => setCancel(null)}>
          <FileIdentity name={cancel.name} />
          <p>다시 올리려면 처음부터 시작해야 합니다.</p>
          <div className="dialog-actions">
            <button className="btn secondary" onClick={() => setCancel(null)}>
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
const labels: Record<QueueState, string> = {
  queued: '시작 대기',
  needs_auth: '인증 필요',
  creating: '전송 준비 중',
  uploading: '전송 중',
  retrying: '연결 재시도',
  offline: '인터넷 연결 대기',
  finalizing: '파일 확인 중',
  ready: '업로드 완료',
  cancel_pending: '취소 확인 중',
  cancelled: '취소됨',
  failed: '전송 확인 필요',
};
function UploadItem({
  item,
  cancel,
  reauth,
  receive,
}: {
  item: QueueView;
  cancel: () => void;
  reauth: () => void;
  receive: () => void;
}) {
  const queued = ['queued', 'needs_auth'].includes(item.state),
    progressing = ['uploading', 'retrying', 'offline', 'finalizing'].includes(item.state);
  return (
    <article className="upload-row transfer-row">
      <FileIdentity name={item.name} previewFile={item.sourceFile} detail={bytes(item.size)} />
      <span
        className={`status ${item.state === 'ready' ? 'success' : item.state === 'failed' ? 'danger-text' : item.state === 'offline' || item.state === 'needs_auth' ? 'warning-text' : ''}`}
      >
        {item.state === 'ready' && <Icon name="check" size={16} />}{' '}
        {item.resultDeleted
          ? '서버 파일 삭제됨'
          : item.state === 'queued' && item.approved
            ? '순서 대기'
            : labels[item.state]}
      </span>
      {progressing && (
        <div className="progress-section">
          <div
            className="progress"
            role="progressbar"
            aria-label={`${item.name} 전송률`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={item.progress}
            aria-valuetext={
              item.state === 'finalizing' ? '전송 100%, 파일 확인 중' : `${item.progress}%`
            }
          >
            <div style={{ width: `${item.progress}%` }} />
          </div>
          <div className="progress-meta">
            <span>
              {bytes(item.bytes)} / {bytes(item.size)}
              {item.state === 'uploading' && (
                <> · {item.speed > 0 ? `${bytes(item.speed)}/s` : '속도 계산 중'}</>
              )}
            </span>
            <strong>
              {item.progress}%{item.state === 'finalizing' ? ' · 확인 중' : ''}
            </strong>
          </div>
        </div>
      )}
      <ErrorText error={item.error} />
      <div className="transfer-retention">
        {queued ? (
          <label className="retention">
            보관 기간
            <select
              aria-label={`${item.name} 보관 기간`}
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
            {item.result && !item.resultDeleted
              ? `만료 ${dateTime(item.result.expiresAt)}`
              : item.resultDeleted
                ? '이 탭의 전송 이력입니다.'
                : item.state === 'finalizing'
                  ? '서버 확인 후 다른 기기에서 받을 수 있습니다.'
                  : item.state === 'cancelled'
                    ? '전송 취소됨'
                    : `완료 후 ${retentionText(item.retention)} 보관`}
          </span>
        )}
      </div>
      <div className="button-row transfer-actions">
        {item.state === 'ready' && !item.resultDeleted && (
          <button className="btn small secondary" onClick={receive}>
            파일 받기 <Icon name="arrow" size={16} />
          </button>
        )}
        {item.state === 'needs_auth' && (
          <button className="btn small secondary" onClick={reauth}>
            다시 인증
          </button>
        )}
        {queued || ['ready', 'cancelled'].includes(item.state) ? (
          <button className="btn small quiet" onClick={() => engine.remove(item.key)}>
            {isTransferHistory(item) ? '내역에서 제거' : '목록에서 제거'}
          </button>
        ) : item.recovery === 'check_result' || item.recovery === 'confirm_cancel' ? (
          <>
            <button
              className="btn small secondary"
              disabled={item.checking}
              onClick={() => void engine.checkResult(item.key)}
            >
              {item.checking ? '확인 중…' : '결과 확인'}
            </button>
            {item.recovery === 'confirm_cancel' && (
              <button className="btn quiet small danger-text" onClick={cancel}>
                취소 확인
              </button>
            )}
          </>
        ) : item.state === 'failed' ? (
          <>
            <button className="btn small secondary" onClick={() => void engine.restart(item.key)}>
              새로 시작
            </button>
            <button className="btn quiet small" onClick={cancel}>
              취소 확인
            </button>
          </>
        ) : (
          !['finalizing', 'cancel_pending'].includes(item.state) && (
            <button className="btn small quiet" onClick={cancel}>
              업로드 취소
            </button>
          )
        )}
      </div>
    </article>
  );
}
