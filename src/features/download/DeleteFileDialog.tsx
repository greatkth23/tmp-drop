import { useState } from 'react';
import type { AuthStatus, FileSummary } from '../../../shared/contracts';
import { ApiFailure, message, mutate } from '../../api';
import { Dialog, ErrorText, FileIdentity } from '../../components/Ui';
import { TotpForm } from '../auth/AuthForms';
import { bytes } from '../../lib/format';
export function DeleteFileDialog({
  file,
  auth,
  refresh,
  onDeleted,
  onReconcile,
  onClose,
  connected,
}: {
  file: FileSummary;
  auth: AuthStatus;
  refresh: () => Promise<AuthStatus | null>;
  onDeleted: () => void;
  onReconcile: () => Promise<void>;
  onClose: () => void;
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const remove = async (grant?: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await mutate<{ state: string }>(
        `/api/files/${file.id}`,
        {},
        'DELETE',
        grant ? { 'X-Admin-Grant': grant } : {},
      );
      if (result.state !== 'DELETED')
        throw new Error('삭제 결과를 확인하지 못했습니다. 목록을 다시 확인해 주세요.');
      onDeleted();
    } catch (e) {
      await refresh();
      await onReconcile();
      if (e instanceof ApiFailure && e.code === 'DELETE_FAILED')
        setError(
          '파일을 목록에서 숨겼지만 저장소 정리가 지연되고 있습니다. 자동으로 다시 시도합니다.',
        );
      else setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="파일을 영구 삭제할까요?" busy={busy} onClose={onClose}>
      <FileIdentity name={file.filename} detail={bytes(file.sizeBytes)} />
      <p>삭제 후 다른 기기에서 새로 다운로드할 수 없으며 복구할 수 없습니다.</p>
      <ErrorText error={error} />
      {auth.uploadAuth === 'trusted' ? (
        <>
          <p className="help">이 브라우저는 신뢰 기기입니다. 확인 후 코드 없이 삭제합니다.</p>
          <div className="dialog-actions">
            <button className="btn secondary" disabled={busy} onClick={onClose}>
              취소
            </button>
            <button
              className="btn danger"
              disabled={busy || !connected}
              onClick={() => void remove()}
            >
              {busy ? '삭제 중…' : '영구 삭제'}
            </button>
          </div>
        </>
      ) : (
        <>
          <TotpForm
            intent="delete_file"
            disabled={!connected}
            targetId={file.id}
            onBusyChange={setBusy}
            onSuccess={remove}
          />
          <button className="btn secondary full spaced" disabled={busy} onClick={onClose}>
            취소
          </button>
        </>
      )}
      <p className="help deletion-help">
        이미 받은 파일과 진행 중인 다운로드의 수신 데이터는 회수되지 않습니다.
      </p>
    </Dialog>
  );
}
