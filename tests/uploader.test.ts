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

const fixtureFile = (name = 'test.bin') => new File([new Uint8Array([1, 2, 3])], name);
const creations = () => apiMocks.mutate.mock.calls.filter(([path]) => path === '/api/uploads');
it('uses one batch per start and a new batch on the next start', async () => {
  const engine = new Engine();
  engine.add([fixtureFile('a'), fixtureFile('b')], 3600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot().every((f) => f.state === 'ready')).toBe(true));
  const first = creations().map(([, body]) => (body as { batchKey: string }).batchKey);
  expect(first[0]).toBeTruthy();
  expect(first[0]).toBe(first[1]);
  engine.add([fixtureFile('c')], 3600);
  engine.start();
  await vi.waitFor(() => expect(creations()).toHaveLength(3));
  expect((creations()[2][1] as { batchKey: string }).batchKey).not.toBe(first[0]);
});
it('can start again after part authorization expires without querying with the expired capability', async () => {
  const implementation = apiMocks.mutate.getMockImplementation()!;
  apiMocks.mutate.mockImplementationOnce(async (path: string, ...args: unknown[]) => ({
    ...(await implementation(path, ...args)),
    capabilityExpiresAt: Date.now() - 1,
  }));
  const engine = new Engine();
  engine.add([fixtureFile()], 3600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot()[0].errorCode).toBe('CAPABILITY_EXPIRED'));
  apiMocks.mutate.mockImplementation(implementation);
  await engine.restart(engine.getSnapshot()[0].key);
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('ready'));
  expect(creations()).toHaveLength(2);
  expect(apiMocks.api).not.toHaveBeenCalled();
  expect(sent).toBe(1);
});
it('starts only explicitly approved files, including files added while another upload is active', async () => {
  online.onLine = false;
  const engine = new Engine();
  engine.add([fixtureFile('first.bin')], 3600);
  engine.start([engine.getSnapshot()[0].key]);
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('offline'));
  engine.add([fixtureFile('later.bin')], 86400);
  online.onLine = true;
  events.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('ready'));
  expect(engine.getSnapshot()[1]).toMatchObject({ state: 'queued', approved: false });
  expect(creations()).toHaveLength(1);
  engine.start([engine.getSnapshot()[1].key]);
  await vi.waitFor(() => expect(engine.getSnapshot()[1].state).toBe('ready'));
  expect(creations()).toHaveLength(2);
});
it('preserves the idempotency key after a lost create response and leaves other files unapproved', async () => {
  const implementation = apiMocks.mutate.getMockImplementation()!;
  apiMocks.mutate.mockImplementationOnce(async () => {
    throw new Error('Response lost');
  });
  const engine = new Engine();
  engine.add([fixtureFile(), fixtureFile('unapproved.bin')], 3600);
  const key = engine.getSnapshot()[0].key;
  engine.start([key]);
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('failed'));
  apiMocks.mutate.mockImplementation(implementation);
  await engine.restart(key);
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('ready'));
  expect(creations()[0][3]).toEqual(creations()[1][3]);
  expect(engine.getSnapshot()[1]).toMatchObject({ state: 'queued', approved: false });
});
it('checks a pending finalization using the original upload instead of creating a new upload', async () => {
  const implementation = apiMocks.mutate.getMockImplementation()!;
  apiMocks.mutate.mockImplementation(async (path: string, ...args: unknown[]) =>
    path.endsWith('/complete')
      ? { state: 'UPLOADING', result: null }
      : implementation(path, ...args),
  );
  const engine = new Engine();
  engine.add([fixtureFile()], 3600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot()[0].recovery).toBe('check_result'));
  expect(engine.getSnapshot()[0].state).toBe('finalizing');
  apiMocks.api.mockResolvedValue({
    state: 'READY',
    result: { id: 'fixture', filename: 'test.bin', sizeBytes: 3, expiresAt: Date.now() + 3600_000 },
  });
  await engine.checkResult(engine.getSnapshot()[0].key);
  expect(engine.getSnapshot()[0].state).toBe('ready');
  expect(creations()).toHaveLength(1);
  expect(sent).toBe(1);
});
it('retains uncertain finalization credentials when access is ended and reflects a deleted result', async () => {
  const implementation = apiMocks.mutate.getMockImplementation()!;
  apiMocks.mutate.mockImplementation(async (path: string, ...args: unknown[]) =>
    path.endsWith('/complete')
      ? { state: 'UPLOADING', result: null }
      : implementation(path, ...args),
  );
  const engine = new Engine();
  engine.add([fixtureFile()], 3600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot()[0].recovery).toBe('check_result'));
  engine.stopAfterLogout();
  expect(engine.getSnapshot()[0]).toMatchObject({ state: 'failed', recovery: 'check_result' });
  expect(engine.activeCredentials()).toHaveLength(1);
  apiMocks.api.mockResolvedValue({ state: 'READY', result: { id: 'fixture' } });
  await engine.checkResult(engine.getSnapshot()[0].key);
  engine.markDeleted('other');
  expect(engine.getSnapshot()[0].resultDeleted).toBeUndefined();
  engine.markDeleted('fixture');
  expect(engine.getSnapshot()[0].resultDeleted).toBe(true);
});

it('clears only completed or cancelled history and preserves pending and recovery work', async () => {
  const engine = new Engine();
  engine.add([new File(['done'], 'done.txt')], 21600);
  engine.start();
  await vi.waitFor(() => expect(engine.getSnapshot()[0].state).toBe('ready'));
  engine.add([new File(['wait'], 'wait.txt')], 21600);
  const waiting = engine.getSnapshot().find((i) => i.name === 'wait.txt')!;
  apiMocks.mutate.mockClear();
  engine.clearHistory();
  expect(engine.getSnapshot()).toHaveLength(1);
  expect(engine.getSnapshot()[0]).toMatchObject({
    key: waiting.key,
    state: 'queued',
    retention: 21600,
  });
  expect(apiMocks.mutate).not.toHaveBeenCalled();
  const { isTransferHistory } = await import('../src/uploader');
  for (const state of [
    'failed',
    'needs_auth',
    'cancel_pending',
    'finalizing',
    'offline',
    'retrying',
  ] as const)
    expect(isTransferHistory({ state })).toBe(false);
  expect(isTransferHistory({ state: 'cancelled' })).toBe(true);
});

it('renders pending and failed uploads without completed history and defaults new files to six hours', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { UploadPage } = await import('../src/features/upload/UploadPage');
  const auth = {
    uploadAuth: 'trusted',
    deviceName: 'Test',
    limits: { webMax: 32 * 1024 ** 3 },
  } as import('../shared/contracts').AuthStatus;
  const base = { size: 3, retention: 86400, approved: false, progress: 0, bytes: 0, speed: 0 };
  const queue: import('../src/uploader').QueueView[] = [
    { ...base, key: 'done', name: 'completed-history-only.txt', state: 'ready' },
    { ...base, key: 'waiting', name: 'new-waiting.txt', state: 'queued' },
    {
      ...base,
      key: 'failed',
      name: 'recover-this.txt',
      state: 'failed',
      error: '전송 확인 필요',
      recovery: 'restart',
    },
  ];
  const html = renderToStaticMarkup(
    createElement(UploadPage, {
      auth,
      queue,
      refresh: async () => auth,
      offset: 0,
      ending: () => {},
      navigate: () => {},
      connected: true,
    }),
  );
  expect(html).toContain('new-waiting.txt');
  expect(html).toContain('recover-this.txt');
  expect(html).not.toContain('completed-history-only.txt');
  expect(html).toContain('새로 시작');
  expect(html).toContain('value="21600" selected=""');
  expect(html).toContain('value="86400" selected=""');
  expect(html.indexOf('1개 파일 업로드 시작')).toBeLessThan(html.indexOf('new-waiting.txt'));
});
it('suggests reducing the selection when no terminal history can be cleared', () => {
  const engine = new Engine();
  expect(() =>
    engine.add(
      Array.from({ length: 51 }, (_, i) => new File(['x'], i + '.txt')),
      21600,
    ),
  ).toThrow('선택 개수를 줄여 주세요');
  expect(engine.getSnapshot()).toHaveLength(0);
});
