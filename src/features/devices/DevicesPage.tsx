import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus, DeviceSummary } from '../../../shared/contracts';
import { api, message, mutate } from '../../api';
import { Dialog, ErrorText, PageHead } from '../../components/Ui';
import { Icon } from '../../components/Icon';
import { dateTime } from '../../lib/format';
import type { Page } from '../../lib/format';
import { TotpForm } from '../auth/AuthForms';
import { engine } from '../../uploader';
export function DevicesPage({
  auth,
  refresh,
  navigate,
}: {
  auth: AuthStatus;
  refresh: () => Promise<AuthStatus | null>;
  navigate: (page: Page) => void;
}) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null),
    [error, setError] = useState(''),
    [dialog, setDialog] = useState<'shortcut' | DeviceSummary | null>(null),
    [token, setToken] = useState(''),
    [name, setName] = useState('내 iPhone 단축어'),
    [busy, setBusy] = useState(false),
    [copyState, setCopyState] = useState(''),
    [closing, setClosing] = useState(false),
    [notice, setNotice] = useState('');
  const load = useCallback(async (grant?: string) => {
    const result = await api<{ devices: DeviceSummary[] }>('/api/devices', {
      headers: grant ? { 'X-Admin-Grant': grant } : {},
    });
    setDevices(result.devices);
    setError('');
  }, []);
  useEffect(() => {
    if (auth.uploadAuth === 'trusted') void load().catch((e) => setError(message(e)));
  }, [auth.uploadAuth, load]);
  const closeNow = () => {
    setDialog(null);
    setToken('');
    setError('');
    setCopyState('');
    setClosing(false);
  };
  const close = () => {
    if (busy) return;
    if (token) setClosing(true);
    else closeNow();
  };
  const create = async (grant?: string) => {
    const result = await mutate<{ id: string; token: string }>(
      '/api/devices',
      { name, kind: 'shortcut' },
      'POST',
      { 'X-Admin-Grant': grant || '' },
    );
    setToken(result.token);
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
  };
  const revoke = async (grant?: string) => {
    if (!dialog || dialog === 'shortcut') return;
    const target = dialog;
    await mutate(`/api/devices/${target.id}`, {}, 'DELETE', { 'X-Admin-Grant': grant || '' });
    setDevices((old) => old?.filter((d) => d.id !== target.id) || []);
    setNotice(`${target.name}의 업로드 권한을 해제했습니다.`);
    closeNow();
    if (target.current) {
      engine.stopAfterLogout();
      setDevices(null);
    }
    await refresh();
  };
  return (
    <>
      <PageHead
        title="내 기기"
        body="어디서 올릴 수 있는지 확인하고 관리하세요."
        right={
          (devices || auth.uploadAuth === 'trusted') && (
            <button
              className="btn primary"
              onClick={() => {
                setError('');
                setDialog('shortcut');
              }}
            >
              <Icon name="plus" size={18} />
              단축어 연결
            </button>
          )
        }
      />
      {!devices && auth.uploadAuth !== 'trusted' ? (
        <section className="auth-wrap panel">
          <span className="auth-symbol">
            <Icon name="device" size={28} />
          </span>
          <h2>기기 관리를 위해 인증해 주세요.</h2>
          <p className="muted">관리 인증은 이 브라우저를 신뢰 기기로 등록하지 않습니다.</p>
          <TotpForm intent="manage" onSuccess={load} />
        </section>
      ) : (
        <>
          <ErrorText error={error} />
          {notice && (
            <p className="notice" role="status">
              <Icon name="check" size={18} />
              {notice}
            </p>
          )}
          <div className="section-head">
            <h2>
              등록 기기 <span className="count">{devices?.length || 0}</span>
            </h2>
            <span>브라우저와 단축어의 업로드 권한</span>
          </div>
          <section className="panel device-list">
            {!devices ? (
              <div className="empty">
                <p>
                  {error ? '기기 목록을 불러오지 못했습니다.' : '등록한 기기를 확인하고 있습니다…'}
                </p>
                {error && (
                  <button
                    className="btn secondary"
                    onClick={() => void load().catch((e) => setError(message(e)))}
                  >
                    다시 불러오기
                  </button>
                )}
              </div>
            ) : !devices.length ? (
              <div className="empty">
                <Icon name="device" size={32} />
                <h2>등록한 기기가 없어요.</h2>
                <p>개인 브라우저에서 파일을 올릴 때 등록할 수 있습니다.</p>
              </div>
            ) : (
              devices.map((d) => (
                <article className="device-row" key={d.id}>
                  <span className="device-icon">
                    <Icon name={d.kind === 'shortcut' ? 'phone' : 'device'} size={26} />
                  </span>
                  <div className="file-info">
                    <div className="device-name">
                      <strong className="filename">{d.name}</strong>
                      {d.current && <span className="tiny-badge">현재 브라우저</span>}
                    </div>
                    <span className="filemeta">
                      {d.kind === 'shortcut' ? '단축어 업로드 전용' : '브라우저 업로드'} · 마지막
                      사용 {dateTime(d.lastUsedAt)}
                    </span>
                  </div>
                  <button
                    className="btn quiet small danger-text"
                    aria-label={`${d.name} 업로드 권한 해제`}
                    onClick={() => {
                      setError('');
                      setDialog(d);
                    }}
                  >
                    권한 해제
                    <Icon name="arrow" size={16} />
                  </button>
                </article>
              ))
            )}
          </section>
          <div className="device-help">
            <Icon name="lock" size={20} />
            <div>
              <strong>더 이상 쓰지 않는 기기는 권한을 해제하세요.</strong>
              <p>
                선택한 등록의 새 업로드와 후속 전송 요청을 차단합니다. 파일 받기 권한과는
                별개입니다.
              </p>
            </div>
          </div>
        </>
      )}
      {dialog && (
        <Dialog
          title={
            closing
              ? '토큰을 저장했나요?'
              : dialog === 'shortcut'
                ? token
                  ? '개인 단축어에 토큰을 입력하세요'
                  : '단축어 연결'
                : '업로드 권한을 해제할까요?'
          }
          onClose={close}
          busy={busy}
        >
          {closing ? (
            <>
              <p>닫으면 이 토큰을 다시 볼 수 없습니다. 저장하지 않았다면 설정을 계속하세요.</p>
              <div className="dialog-actions">
                <button className="btn secondary" onClick={() => setClosing(false)}>
                  설정 계속
                </button>
                <button className="btn primary" onClick={closeNow}>
                  저장했고 닫기
                </button>
              </div>
            </>
          ) : dialog === 'shortcut' ? (
            token ? (
              <>
                <span className="badge accent-badge">한 번만 표시됩니다</span>
                <p>이 토큰은 파일 업로드 전용입니다. 단축어를 공유하기 전에 토큰을 제거하세요.</p>
                <textarea
                  className="token"
                  aria-label="단축어 업로드 토큰"
                  readOnly
                  value={token}
                  onFocus={(e) => e.target.select()}
                />
                <p className="help">
                  설치 파일은 제공하지 않습니다. 아래 안내에 따라 설정하세요. 묶음 ID를 추가한
                  버전은 iPhone에서 확인이 필요합니다.
                </p>
                <a className="text-link" href="/shortcuts" target="_blank" rel="noreferrer">
                  단축어 설정 안내 열기
                </a>
                {copyState && (
                  <p className="notice" role="status">
                    {copyState}
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    className="btn secondary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(token)
                        .then(() => setCopyState('토큰을 복사했습니다.'))
                        .catch(() => setCopyState('토큰을 직접 선택해 복사해 주세요.'));
                    }}
                  >
                    토큰 복사
                  </button>
                  <button className="btn primary" onClick={close}>
                    설정 확인
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="field">
                  기기 이름
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={50}
                    required
                    disabled={busy}
                  />
                </label>
                <p>이 이름으로 업로드 전용 토큰을 만듭니다. 토큰은 생성 후 한 번만 표시됩니다.</p>
                <TotpForm
                  intent="create_device"
                  onBusyChange={setBusy}
                  onSuccess={create}
                  validate={() => (name.trim() ? undefined : '기기 이름을 입력해 주세요.')}
                />
              </>
            )
          ) : (
            <>
              <strong className="target-name">{dialog.name}</strong>
              <p>
                이 등록의 새 업로드와 후속 전송 요청이 차단됩니다.
                {dialog.current && ' 현재 브라우저도 다시 인증해야 합니다.'}
              </p>
              <TotpForm
                intent="revoke_device"
                targetId={dialog.id}
                onBusyChange={setBusy}
                onSuccess={revoke}
              />
            </>
          )}
          <ErrorText error={error} />
        </Dialog>
      )}
      <a
        className="text-link shortcut-link"
        href="/shortcuts"
        onClick={(e) => {
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
            e.preventDefault();
            navigate('shortcuts');
          }
        }}
      >
        iPhone 단축어 설정 안내 <Icon name="arrow" size={16} />
      </a>
    </>
  );
}
