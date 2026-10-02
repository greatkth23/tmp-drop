import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
const apiMocks = vi.hoisted(() => ({ api: vi.fn(), mutate: vi.fn(), authStatus: vi.fn() }));
vi.mock('../src/api', () => ({
  ...apiMocks,
  ApiFailure: class extends Error {
    constructor(
      public code: string,
      message: string,
      public retryable = false,
      public retryAfterSeconds = 0,
    ) {
      super(message);
    }
  },
}));
let Engine: typeof import('../src/uploader').UploadEngine;
let online: { onLine: boolean }, events: EventTarget, sent: number, loseFirst: boolean;
class FakeXHR {
  status = 200;
  responseText = '{}';
  timeout = 0;
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  abort() {
    this.onabort?.();
  }
  send() {
    sent++;
    queueMicrotask(() => {
      if (loseFirst && sent === 1) {
        online.onLine = false;
        this.onerror?.();
      } else this.onload?.();
    });
  }
}
beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Engine = (await import('../src/uploader')).UploadEngine;
});
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  online = { onLine: true };
  events = new EventTarget();
  sent = 0;
  loseFirst = false;
  vi.stubGlobal('navigator', online);
  vi.stubGlobal('window', events);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  apiMocks.api.mockReset();
  apiMocks.mutate.mockReset();
  apiMocks.mutate.mockImplementation(async (path: string) =>
    path === '/api/uploads'
      ? {
          id: 'fixture',
          capability: 'C'.repeat(43),
          capabilityExpiresAt: Date.now() + 600_000,
          partSizeBytes: 64 * 1024 ** 2,
          partCount: 1,
          serverNow: Date.now(),
        }
      : {
          state: 'READY',
          result: {
            id: 'fixture',
            filename: 'offline.bin',
            sizeBytes: 3,
            completedAt: Date.now(),
            expiresAt: Date.now() + 3600_000,
          },
        },
  );
  apiMocks.api.mockResolvedValue({
    state: 'UPLOADING',
    completedParts: [{ partNumber: 1, bytes: 3 }],
  });
});
afterEach(() => vi.unstubAllGlobals());
it('waits while offline and resumes the same queued file when connectivity returns', async () => {
  online.onLine = false;
  const engine = new Engine();
  engine.add([new File([new Uint8Array([1, 2, 3])], 'offline.bin')], 3600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('offline'));
  expect(apiMocks.mutate).not.toHaveBeenCalled();
  expect(sent).toBe(0);
  online.onLine = true;
  events.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('ready'));
  expect(apiMocks.mutate.mock.calls.filter(([path]) => path === '/api/uploads')).toHaveLength(1);
  expect(sent).toBe(1);
});
it('checks the server after an offline response loss and does not resend an accepted part', async () => {
  loseFirst = true;
  const engine = new Engine();
  engine.add([new File([new Uint8Array([1, 2, 3])], 'offline.bin')], 3600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('offline'));
  online.onLine = true;
  events.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('ready'));
  expect(apiMocks.api).toHaveBeenCalledWith('/api/uploads/fixture', expect.anything());
  expect(sent).toBe(1);
});
