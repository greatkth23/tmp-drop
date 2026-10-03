import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, message, mutate } from '../../api';
import { ErrorText } from '../../components/Ui';
import { Icon } from '../../components/Icon';
export function TotpForm({
  intent = 'upload',
  onSuccess,
  targetId,
  onBusyChange,
  disabled = false,
  validate,
}: {
  intent?: 'upload' | 'manage' | 'create_device' | 'revoke_device' | 'delete_file';
  onSuccess: (grant?: string) => void | Promise<void>;
  targetId?: string;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  validate?: () => string | undefined;
}) {
  const [code, setCode] = useState(''),
    [trust, setTrust] = useState(false),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [retryAt, setRetryAt] = useState(0),
    [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null),
    id = useId();
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || seconds || disabled) return;
    const validationError = validate?.();
    if (validationError) {
      setError(validationError);
      return;
    }
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
      input.current?.select();
      if (e instanceof ApiFailure && e.retryAfterSeconds) {
        setRetryAt(Date.now() + e.retryAfterSeconds * 1000);
        setNow(Date.now());
      }
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} aria-busy={busy}>
      <label className="field">
        Authenticator 코드
        <input
          ref={input}
          className="code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          pattern="[0-9]{6}"
          required
          disabled={busy}
          aria-invalid={!!error}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        />
      </label>
      {intent === 'upload' && (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={trust}
              onChange={(e) => setTrust(e.target.checked)}
              disabled={busy}
            />
            <span>
              내 개인 기기입니다.<small>다음부터 이 브라우저에서 인증 없이 업로드합니다.</small>
            </span>
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
                disabled={busy}
              />
            </label>
          )}
        </>
      )}
      <p className="help" id={`${id}-help`}>
        {intent === 'upload'
          ? trust
            ? '공용 PC에서는 기기를 등록하지 마세요.'
            : '15분 동안 새 업로드를 시작할 수 있습니다.'
          : '이 작업에 사용할 새 Authenticator 코드를 입력하세요.'}
      </p>
      <ErrorText error={error} id={`${id}-error`} />
      <button
        className={`btn full ${intent === 'delete_file' ? 'danger' : 'primary'}`}
        disabled={busy || seconds > 0 || disabled}
      >
        {busy
          ? '처리 중…'
          : seconds
            ? `${seconds}초 후 다시 시도`
            : intent === 'delete_file'
              ? '인증하고 영구 삭제'
              : '인증하고 계속'}
        {!busy && !seconds && <Icon name={intent === 'delete_file' ? 'trash' : 'arrow'} />}
      </button>
    </form>
  );
}
