import type { FileSummary } from '../../../shared/contracts';
export type DeleteResult = { id: string; state: string; message?: string };
export type DeletionJob = {
  key: number;
  ids: string[];
  pending: boolean;
  removed: string[];
  error: string;
  text: string;
};
type Send = (files: FileSummary[], batch: boolean, grant?: string) => Promise<DeleteResult[]>;
export function createDeletionJobs(send: Send, markDeleted: (id: string) => void) {
  let snapshot: DeletionJob[] = [],
    serial = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dismiss: (key: number) => {
      snapshot = snapshot.filter((job) => job.key !== key || job.pending);
      emit();
    },
    start(files: FileSummary[], batch: boolean, grant?: string) {
      if (files.some((file) => snapshot.some((job) => job.pending && job.ids.includes(file.id))))
        return;
      const key = ++serial;
      snapshot = [
        ...snapshot,
        {
          key,
          ids: files.map((file) => file.id),
          pending: true,
          removed: [],
          error: '',
          text: `${files.length}개 파일 삭제 요청 중… 다른 화면을 이용해도 됩니다.`,
        },
      ];
      emit();
      void send(files, batch, grant)
        .then((results) => {
          const removed = results
            .filter((r) => ['DELETED', 'PENDING'].includes(r.state))
            .map((r) => r.id);
          removed.forEach((id) => markDeleted(id));
          const failed = results.filter((r) => !['DELETED', 'PENDING'].includes(r.state));
          snapshot = snapshot.map((job) =>
            job.key === key
              ? {
                  ...job,
                  pending: false,
                  removed,
                  error: failed.length
                    ? `${failed.length}개 파일을 삭제하지 못했습니다. ${failed[0].message || '목록에서 다시 확인해 주세요.'}`
                    : '',
                  text: `${removed.length}개 파일을 목록에서 삭제했습니다.${results.some((r) => r.state === 'PENDING') ? ' 저장소 정리는 백그라운드에서 계속됩니다.' : ''}`,
                }
              : job,
          );
        })
        .catch((error) => {
          snapshot = snapshot.map((job) =>
            job.key === key
              ? {
                  ...job,
                  pending: false,
                  text: '',
                  error: `삭제 요청 결과를 확인하지 못했습니다. ${error instanceof Error ? error.message : '인터넷 연결을 확인해 주세요.'} 목록을 새로고침해 주세요.`,
                }
              : job,
          );
        })
        .finally(emit);
    },
  };
}
