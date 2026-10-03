import { beforeEach, expect, it, vi } from 'vitest';
import type { FileSummary } from '../shared/contracts';
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api', () => mocks);
import { readFilePages } from '../src/features/download/listing';
const file = (id: string) => ({ id, filename: id + '.bin' }) as FileSummary;
beforeEach(() => mocks.api.mockReset());
it('refreshes the entire loaded range after insertions and removals', async () => {
  const signal = new AbortController().signal;
  mocks.api
    .mockResolvedValueOnce({ files: [file('a'), file('b')], nextCursor: 'first', serverNow: 1 })
    .mockResolvedValueOnce({ files: [file('c'), file('d')], nextCursor: 'second', serverNow: 2 });
  expect((await readFilePages(2, signal)).files.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd']);
  mocks.api
    .mockResolvedValueOnce({ files: [file('new'), file('a')], nextCursor: 'changed', serverNow: 3 })
    .mockResolvedValueOnce({ files: [file('c'), file('d')], nextCursor: 'second', serverNow: 4 });
  expect((await readFilePages(2, signal)).files.map((f) => f.id)).toEqual(['new', 'a', 'c', 'd']);
  expect(mocks.api.mock.calls[2][0]).toBe('/api/files');
  expect(mocks.api.mock.calls[3][0]).toBe('/api/files?cursor=changed');
});
it('deduplicates overlapping pages and stops at the end while safely encoding a cursor', async () => {
  mocks.api
    .mockResolvedValueOnce({ files: [file('a'), file('b')], nextCursor: '+/=', serverNow: 1 })
    .mockResolvedValueOnce({ files: [file('b'), file('c')], nextCursor: null, serverNow: 2 });
  const result = await readFilePages(4, new AbortController().signal);
  expect(result.files.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  expect(result.nextCursor).toBeNull();
  expect(mocks.api).toHaveBeenCalledTimes(2);
  expect(mocks.api.mock.calls[1][0]).toBe('/api/files?cursor=%2B%2F%3D');
});
it('rejects a failed later page instead of returning an incomplete refreshed list', async () => {
  mocks.api
    .mockResolvedValueOnce({ files: [file('a')], nextCursor: 'next', serverNow: 1 })
    .mockRejectedValueOnce(new Error('offline'));
  await expect(readFilePages(2, new AbortController().signal)).rejects.toThrow('offline');
});
