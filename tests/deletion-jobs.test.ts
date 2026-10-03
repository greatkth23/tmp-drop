import { expect, it, vi } from 'vitest';
import { createDeletionJobs } from '../src/features/download/deletionJobsCore';
import type { FileSummary } from '../shared/contracts';
const file = { id: 'one' } as FileSummary;
it('keeps requests alive after subscribers leave and prevents duplicate pending deletion', async () => {
  let finish!: (results: { id: string; state: string }[]) => void;
  const send = vi.fn(
    () =>
      new Promise<{ id: string; state: string }[]>((resolve) => {
        finish = resolve;
      }),
  );
  const removed = vi.fn(),
    jobs = createDeletionJobs(send, removed),
    notify = vi.fn();
  const unsubscribe = jobs.subscribe(notify);
  jobs.start([file], false);
  unsubscribe();
  jobs.start([file], false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(jobs.getSnapshot()[0].pending).toBe(true);
  jobs.dismiss(1);
  expect(jobs.getSnapshot()).toHaveLength(1);
  finish([{ id: 'one', state: 'PENDING' }]);
  await vi.waitFor(() => expect(jobs.getSnapshot()[0].pending).toBe(false));
  expect(removed).toHaveBeenCalledExactlyOnceWith('one');
  expect(jobs.getSnapshot()[0].removed).toEqual(['one']);
});
it('retains actionable errors and does not hide files after an uncertain request', async () => {
  const removed = vi.fn(),
    jobs = createDeletionJobs(async () => {
      throw Error('offline');
    }, removed);
  jobs.start([file], false);
  await vi.waitFor(() => expect(jobs.getSnapshot()[0].error).toContain('offline'));
  expect(jobs.getSnapshot()[0].removed).toEqual([]);
  expect(removed).not.toHaveBeenCalled();
  jobs.dismiss(1);
  expect(jobs.getSnapshot()).toEqual([]);
});
it('reports partial failure without marking failed files as removed', async () => {
  const removed = vi.fn(),
    jobs = createDeletionJobs(
      async () => [
        { id: 'one', state: 'PENDING' },
        { id: 'two', state: 'FAILED', message: 'Try again' },
      ],
      removed,
    );
  jobs.start([file, { id: 'two' } as FileSummary], true);
  await vi.waitFor(() => expect(jobs.getSnapshot()[0].pending).toBe(false));
  expect(jobs.getSnapshot()[0].removed).toEqual(['one']);
  expect(jobs.getSnapshot()[0].error).toContain('Try again');
});
