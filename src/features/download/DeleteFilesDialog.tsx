import { useState } from 'react';
import type { AuthStatus, FileSummary } from '../../../shared/contracts';
import { deletionJobs } from './deletionJobs';
import { Dialog } from '../../components/Ui';
import { TotpForm } from '../auth/AuthForms';
import { bytes } from '../../lib/format';
export function DeleteFilesDialog({
  files,
  auth,
  connected,
  onClose,
}: {
  files: FileSummary[];
  auth: AuthStatus;
  connected: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const remove = (grant?: string) => {
    deletionJobs.start(files, true, grant);
    onClose();
  };
  return (
    <Dialog title={`선택한 ${files.length}개 파일을 삭제할까요?`} busy={busy} onClose={onClose}>
      <p>선택한 파일만 영구 삭제합니다. 삭제한 파일은 복구할 수 없습니다.</p>
      <ul className="bulk-delete-list">
        {files.map((f) => (
          <li key={f.id}>
            {f.filename}
            <small>{bytes(f.sizeBytes)}</small>
          </li>
        ))}
      </ul>
      {auth.uploadAuth === 'trusted' ? (
        <div className="dialog-actions">
          <button className="btn secondary" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            className="btn danger"
            disabled={busy || !connected}
            onClick={() => void remove()}
          >
            {busy ? '삭제 중…' : `${files.length}개 영구 삭제`}
          </button>
        </div>
      ) : (
        <>
          <TotpForm
            intent="delete_files"
            targetIds={files.map((f) => f.id)}
            onSuccess={remove}
            onBusyChange={setBusy}
            disabled={!connected}
          />
          <button className="btn secondary full spaced" disabled={busy} onClick={onClose}>
            취소
          </button>
        </>
      )}
    </Dialog>
  );
}
