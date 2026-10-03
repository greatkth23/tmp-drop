import { useState } from 'react';
import type { AuthStatus, FileSummary } from '../../../shared/contracts';
import { deletionJobs } from './deletionJobs';
import { Dialog, FileIdentity } from '../../components/Ui';
import { TotpForm } from '../auth/AuthForms';
import { bytes } from '../../lib/format';
export function DeleteFileDialog({
  file,
  auth,
  onClose,
  connected,
}: {
  file: FileSummary;
  auth: AuthStatus;
  onClose: () => void;
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const remove = (grant?: string) => {
    deletionJobs.start([file], false, grant);
    onClose();
  };
  return (
    <Dialog title="파일을 영구 삭제할까요?" busy={busy} onClose={onClose}>
      <FileIdentity name={file.filename} detail={bytes(file.sizeBytes)} />
      <p>삭제 후 다른 기기에서 새로 다운로드할 수 없으며 복구할 수 없습니다.</p>
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
