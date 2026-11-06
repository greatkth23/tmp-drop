import { api, mutate, ApiFailure, authStatus } from './api';
import { POLICY } from '../shared/contracts';
import type { UploadCreated, UploadStatus, FileSummary } from '../shared/contracts';
export type QueueState =
  | 'queued'
  | 'needs_auth'
  | 'creating'
  | 'uploading'
  | 'retrying'
  | 'offline'
  | 'finalizing'
  | 'ready'
  | 'cancel_pending'
  | 'cancelled'
  | 'failed';
export interface QueueView {
  sourceFile?: File;
  key: string;
  name: string;
  size: number;
  retention: number;
  state: QueueState;
  approved: boolean;
  progress: number;
  bytes: number;
  speed: number;
  error?: string;
  errorCode?: string;
  recovery?: 'check_result' | 'restart' | 'confirm_cancel' | 'reauth';
  checking?: boolean;
  resultDeleted?: boolean;
  result?: FileSummary;
}
export const isTransferHistory = (item: Pick<QueueView, 'state'>) =>
  ['ready', 'cancelled'].includes(item.state);
interface QueueItem extends QueueView {
  file: File;
  batchKey?: string;
  id?: string;
  capability?: string;
  expiresAt?: number;
  clockOffset?: number;
  idempotencyKey: string;
  controller: AbortController;
  confirmed: Map<number, number>;
  inFlight: Map<number, number>;
}
class Slots {
  active = 0;
  waiters: { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  constructor(private max: number) {}
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject, signal }));
  }
  release() {
    this.active--;
    while (this.waiters.length) {
      const next = this.waiters.shift()!;
      if (next.signal.aborted) {
        next.reject(new DOMException('Cancelled', 'AbortError'));
        continue;
      }
      this.active++;
      next.resolve();
      break;
    }
  }
}
export class UploadEngine {
  private items: QueueItem[] = [];
  private snapshot: QueueView[] = [];
  private listeners = new Set<() => void>();
  private running = 0;
  private enabled = false;
  private slots = new Slots(matchMedia('(max-width: 719px)').matches ? 2 : 4);
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = this.items.map(
      ({
        file,
        key,
        name,
        size,
        retention,
        state,
        approved,
        progress,
        bytes,
        speed,
        error,
        errorCode,
        recovery,
        checking,
        resultDeleted,
        result,
      }) => ({
        sourceFile: file,
        key,
        name,
        size,
        retention,
        state,
        approved,
        progress,
        bytes,
        speed,
        error,
        errorCode,
        recovery,
        checking,
        resultDeleted,
        result,
      }),
    );
    this.listeners.forEach((fn) => fn());
  }
  add(files: File[], retention: number) {
    if (this.items.length + files.length > 50)
      throw new Error(
        this.items.some(isTransferHistory)
          ? '한 탭에 최대 50개 파일을 담을 수 있습니다. 선택 개수를 줄이거나 전송 내역을 비워 주세요.'
          : '한 탭에 최대 50개 파일을 담을 수 있습니다. 선택 개수를 줄여 주세요.',
      );
    for (const file of files) {
      if (file.size === 0 || file.size > POLICY.webMax)
        throw new Error('빈 파일 또는 32 GiB를 넘는 파일은 선택할 수 없습니다.');
    }
    this.items.push(
      ...files.map((file) => ({
        key: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        retention,
        state: 'queued' as const,
        approved: false,
        progress: 0,
        bytes: 0,
        speed: 0,
        file,
        idempotencyKey: crypto.randomUUID(),
        controller: new AbortController(),
        confirmed: new Map<number, number>(),
        inFlight: new Map<number, number>(),
      })),
    );
    this.emit();
  }
  changeRetention(key: string, retention: number) {
    const item = this.items.find((i) => i.key === key);
    if (item && ['queued', 'needs_auth'].includes(item.state)) {
      item.retention = retention;
      this.emit();
    }
  }
  clearHistory() {
    this.items = this.items.filter((item) => !isTransferHistory(item));
    this.emit();
  }
  remove(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (item && !['queued', 'needs_auth', 'ready', 'cancelled'].includes(item.state)) return;
    this.items = this.items.filter((i) => i.key !== key);
    this.emit();
  }
  start(
    keys = this.items.filter((i) => ['queued', 'needs_auth'].includes(i.state)).map((i) => i.key),
  ) {
    this.enabled = true;
    const batchKey = crypto.randomUUID();
    this.items.forEach((i) => {
      if (!keys.includes(i.key) || !['queued', 'needs_auth'].includes(i.state)) return;
      i.batchKey ||= batchKey;
      i.approved = true;
      if (i.state === 'needs_auth') {
        i.state = 'queued';
        i.error = undefined;
        i.errorCode = undefined;
        i.recovery = undefined;
      }
    });
    this.emit();
    this.pump();
  }
  markDeleted(id: string) {
    for (const item of this.items) if (item.result?.id === id) item.resultDeleted = true;
    this.emit();
  }
  async checkResult(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (!item?.id || !item.capability || item.checking) return;
    item.checking = true;
    this.emit();
    try {
      const status = await api<UploadStatus>(`/api/uploads/${item.id}`, {
        headers: { Authorization: `Upload ${item.capability}` },
      });
      if (status.state === 'READY' && status.result) {
        item.state = 'ready';
        item.result = status.result;
        item.progress = 100;
        item.bytes = item.size;
        item.error = undefined;
        item.errorCode = undefined;
        item.recovery = undefined;
        item.capability = undefined;
      } else if (status.state === 'FINALIZING') {
        item.state = 'finalizing';
        item.errorCode = 'FINALIZE_PENDING';
        item.recovery = 'check_result';
        item.error = '서버가 파일을 확인하고 있습니다. 잠시 후 결과를 다시 확인해 주세요.';
      } else if (
        ['CANCELLED', 'CANCEL_REQUESTED', 'DELETING', 'DELETED', 'EXPIRED'].includes(status.state)
      ) {
        item.state = 'cancelled';
        item.capability = undefined;
        item.error = undefined;
        item.recovery = undefined;
      } else {
        item.state = 'failed';
        item.recovery = item.recovery === 'confirm_cancel' ? 'confirm_cancel' : 'restart';
        item.error = '전송을 끝내지 못했습니다. 취소하거나 처음부터 다시 시작할 수 있습니다.';
      }
    } catch (error) {
      item.error = messageForUpload(error);
      item.errorCode = error instanceof ApiFailure ? error.code : 'NETWORK_ERROR';
      // An unavailable result is not evidence that the original upload failed.
      item.recovery = 'check_result';
    } finally {
      item.checking = false;
      item.speed = 0;
      this.emit();
    }
  }
  async restart(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (!item || item.state !== 'failed') return;
    if (item.recovery === 'check_result' || item.recovery === 'confirm_cancel') {
      await this.checkResult(key);
      return;
    }
    if (['CAPABILITY_EXPIRED', 'DEVICE_REVOKED'].includes(item.errorCode || '')) {
      // This branch failed before completion was submitted. The old authorization cannot
      // inspect/cancel it; server expiration cleans it up. Unknown finalizations stay above.
      item.id = undefined;
      item.capability = undefined;
      item.idempotencyKey = crypto.randomUUID();
    }
    if (item.id && item.capability) {
      await this.checkResult(key);
      const checked = this.getSnapshot().find((i) => i.key === key);
      if (checked?.state !== 'failed' || checked.recovery === 'check_result') return;
      try {
        await mutate(`/api/uploads/${item.id}`, {}, 'DELETE', {
          Authorization: `Upload ${item.capability}`,
        });
      } catch (error) {
        item.error = messageForUpload(error);
        item.recovery = 'confirm_cancel';
        this.emit();
        return;
      }
    }
    if (item.id) item.idempotencyKey = crypto.randomUUID();
    item.id = undefined;
    item.capability = undefined;
    item.expiresAt = undefined;
    item.controller = new AbortController();
    // A lost create response can have succeeded; keep its request key when no id was received.
    item.confirmed.clear();
    item.inFlight.clear();
    item.bytes = 0;
    item.progress = 0;
    item.speed = 0;
    item.error = undefined;
    item.errorCode = undefined;
    item.recovery = undefined;
    item.approved = false;
    item.state = 'queued';
    this.emit();
    this.start([key]);
  }
  activeCredentials() {
    return this.items
      .filter((i) => i.id && i.capability && !['ready', 'cancelled'].includes(i.state))
      .map((i) => ({ id: i.id!, capability: i.capability! }));
  }
  stopAfterLogout() {
    this.enabled = false;
    for (const i of this.items) {
      if (!['ready', 'cancelled'].includes(i.state)) {
        i.controller.abort();
        if (i.state === 'finalizing' || i.recovery === 'check_result') {
          i.state = 'failed';
          i.recovery = 'check_result';
          i.error =
            '접근을 종료했습니다. 확인 중이던 파일은 완료될 수 있습니다. 파일 받기에서 확인해 주세요.';
          continue;
        }
        i.state = 'cancelled';
        i.capability = undefined;
      }
    }
    this.emit();
  }
  async cancel(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (!item || ['ready', 'finalizing'].includes(item.state)) return;
    item.controller.abort();
    item.state = 'cancel_pending';
    this.emit();
    try {
      if (item.id && item.capability)
        await mutate(`/api/uploads/${item.id}`, {}, 'DELETE', {
          Authorization: `Upload ${item.capability}`,
        });
      item.state = 'cancelled';
      item.capability = undefined;
      item.inFlight.clear();
    } catch (error) {
      item.state = 'failed';
      item.errorCode = error instanceof ApiFailure ? error.code : 'NETWORK_ERROR';
      item.recovery = 'confirm_cancel';
      item.error =
        '취소 확인 실패: ' + (error instanceof Error ? error.message : '다시 시도해 주세요.');
    }
    this.emit();
  }
  private pump() {
    if (!this.enabled) return;
    while (this.running < 2) {
      const item = this.items.find((i) => i.state === 'queued' && i.approved);
      if (!item) break;
      item.state = 'creating';
      this.running++;
      this.emit();
      void this.run(item).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
  private async run(item: QueueItem) {
    try {
      const created = await this.metadata(item, () =>
        mutate<UploadCreated>(
          '/api/uploads',
          {
            filename: item.name,
            sizeBytes: item.size,
            batchKey: item.batchKey,
            mime: item.file.type || 'application/octet-stream',
            retentionSeconds: item.retention,
          },
          'POST',
          { 'Idempotency-Key': item.idempotencyKey },
        ),
      );
      item.id = created.id;
      item.capability = created.capability;
      item.expiresAt = created.capabilityExpiresAt;
      item.clockOffset = created.serverNow - Date.now();
      if (item.controller.signal.aborted) {
        await mutate(`/api/uploads/${item.id}`, {}, 'DELETE', {
          Authorization: `Upload ${item.capability}`,
        });
        item.state = 'cancelled';
        item.capability = undefined;
        this.emit();
        return;
      }
      item.state = 'uploading';
      this.emit();
      let next = 1;
      const sendWorker = async () => {
        while (next <= created.partCount) {
          const n = next++;
          await this.sendPart(item, n, created.partSizeBytes);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, created.partCount) }, () => sendWorker()));
      if (item.controller.signal.aborted) return;
      item.state = 'finalizing';
      item.progress = 100;
      this.emit();
      let completed: { state: string; result: FileSummary | null };
      try {
        completed = await this.metadata(item, () =>
          mutate<{ state: string; result: FileSummary | null }>(
            `/api/uploads/${item.id}/complete`,
            {},
            'POST',
            { Authorization: `Upload ${item.capability}` },
          ),
        );
      } catch (error) {
        const status = await api<UploadStatus>(`/api/uploads/${item.id}`, {
          headers: { Authorization: `Upload ${item.capability}` },
        }).catch(() => null);
        if (!status || !['FINALIZING', 'READY'].includes(status.state)) throw error;
        completed = { state: status.state, result: status.result };
      }
      for (let count = 0; completed.state === 'FINALIZING' && count < 120; count++) {
        await this.delay(count < 20 ? 3000 : 10_000, item.controller.signal);
        const status = await this.metadata(item, () =>
          api<UploadStatus>(`/api/uploads/${item.id}`, {
            headers: { Authorization: `Upload ${item.capability}` },
          }),
        );
        completed = { state: status.state, result: status.result };
      }
      if (completed.state !== 'READY' || !completed.result)
        throw new ApiFailure(
          'FINALIZE_PENDING',
          '파일 확인이 지연되고 있습니다. 서버가 결과를 계속 확인합니다.',
        );
      item.state = 'ready';
      item.result = completed.result;
      item.capability = undefined;
      item.error = undefined;
      item.errorCode = undefined;
      item.recovery = undefined;
      item.bytes = item.size;
      item.progress = 100;
      item.speed = 0;
      this.emit();
    } catch (error) {
      if (item.controller.signal.aborted) return;
      if (error instanceof ApiFailure && error.code === 'UPLOAD_SESSION_EXPIRED') {
        item.state = 'needs_auth';
        item.approved = false;
        item.recovery = 'reauth';
      } else if (item.state === 'finalizing') {
        item.errorCode = 'FINALIZE_PENDING';
        item.recovery = 'check_result';
      } else {
        item.state = 'failed';
        item.recovery = 'restart';
        item.controller.abort();
      }
      item.errorCode ??= error instanceof ApiFailure ? error.code : 'UPLOAD_FAILED';
      item.error = error instanceof Error ? error.message : '전송하지 못했습니다.';
      item.inFlight.clear();
      this.emit();
    }
  }
  private async metadata<T>(item: QueueItem, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.waitOnline(item);
      try {
        return await operation();
      } catch (error) {
        if (item.controller.signal.aborted) throw error;
        if (!navigator.onLine) {
          await this.waitOnline(item);
          attempt--;
          continue;
        }
        if (error instanceof ApiFailure && error.code === 'CSRF_REJECTED' && attempt === 0) {
          await authStatus();
          continue;
        }
        if (!(error instanceof ApiFailure) || !error.retryable || attempt === 5) throw error;
        item.error = error.message;
        this.emit();
        const delay = Math.max(
          1000 * 2 ** attempt + Math.random() * 500,
          error.retryAfterSeconds * 1000,
        );
        if (item.expiresAt && Date.now() + (item.clockOffset || 0) + delay >= item.expiresAt)
          throw new ApiFailure(
            'CAPABILITY_EXPIRED',
            '전송 권한이 만료되어 더 이상 재시도할 수 없습니다.',
          );
        await this.delay(delay, item.controller.signal);
      }
    }
    throw new ApiFailure('REQUEST_FAILED', '요청을 완료하지 못했습니다.');
  }
  private async sendPart(item: QueueItem, n: number, size: number) {
    const start = (n - 1) * size,
      blob = item.file.slice(start, Math.min(start + size, item.size));
    let checkAfterReconnect = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.waitOnline(item);
      if (checkAfterReconnect) {
        const status = await this.metadata(item, () =>
          api<UploadStatus>(`/api/uploads/${item.id}`, {
            headers: { Authorization: `Upload ${item.capability}` },
          }),
        );
        const confirmed = status.completedParts.find((p) => p.partNumber === n);
        if (confirmed) {
          item.confirmed.set(n, confirmed.bytes);
          item.bytes = [...item.confirmed.values()].reduce((a, b) => a + b, 0);
          item.progress = Math.min(99, Math.round((item.bytes / item.size) * 100));
          item.error = undefined;
          this.emit();
          return;
        }
        if (status.state !== 'UPLOADING')
          throw new ApiFailure('UPLOAD_FAILED', '전송 상태가 변경되어 이어서 전송할 수 없습니다.');
        checkAfterReconnect = false;
      }
      let retryDelay = 1000 * 2 ** attempt + Math.random() * 500;
      if (item.expiresAt && item.expiresAt <= Date.now() + (item.clockOffset || 0))
        throw new ApiFailure('CAPABILITY_EXPIRED', '이 파일의 전송 가능 시간이 끝났습니다.');
      await this.slots.acquire(item.controller.signal);
      const started = performance.now();
      try {
        await this.xhr(item, n, blob, (loaded) => {
          item.inFlight.set(n, loaded);
          item.bytes = Math.min(
            item.size,
            [...item.confirmed.values()].reduce((a, b) => a + b, 0) +
              [...item.inFlight.values()].reduce((a, b) => a + b, 0),
          );
          item.progress = Math.min(99, Math.round((item.bytes / item.size) * 100));
          item.speed = loaded / Math.max(0.1, (performance.now() - started) / 1000);
          this.emit();
        });
        item.confirmed.set(n, blob.size);
        item.inFlight.delete(n);
        item.bytes =
          [...item.confirmed.values()].reduce((a, b) => a + b, 0) +
          [...item.inFlight.values()].reduce((a, b) => a + b, 0);
        item.state = 'uploading';
        item.error = undefined;
        this.emit();
        return;
      } catch (error) {
        item.inFlight.delete(n);
        if (item.controller.signal.aborted) throw error;
        if (!navigator.onLine) {
          checkAfterReconnect = true;
          item.state = 'offline';
          item.error = '인터넷 연결이 돌아오면 전송 결과를 확인하고 이어서 전송합니다.';
          item.speed = 0;
          this.emit();
          attempt--;
          continue;
        }
        // A lost response can still correspond to a confirmed part: ask the server first.
        const status = await api<UploadStatus>(`/api/uploads/${item.id}`, {
          headers: { Authorization: `Upload ${item.capability}` },
        }).catch(() => null);
        const confirmed = status?.completedParts.find((p) => p.partNumber === n);
        if (confirmed) {
          item.confirmed.set(n, confirmed.bytes);
          this.emit();
          return;
        }
        if (status && status.state !== 'UPLOADING')
          throw new ApiFailure(
            'UPLOAD_FAILED',
            '전송 상태를 확인하지 못했습니다. 파일을 새로 선택해 주세요.',
          );
        if (!(error instanceof ApiFailure) || !error.retryable || attempt === 5) throw error;
        item.state = 'retrying';
        item.error = error.message;
        this.emit();
        retryDelay = Math.max(retryDelay, error.retryAfterSeconds * 1000);
        // Release the scarce transmission slot before backoff.
      } finally {
        this.slots.release();
      }
      if (item.expiresAt && Date.now() + (item.clockOffset || 0) + retryDelay >= item.expiresAt)
        throw new ApiFailure('CAPABILITY_EXPIRED', '대기 시간 안에 전송 권한이 만료됩니다.');
      await this.delay(retryDelay, item.controller.signal);
    }
  }
  private xhr(
    item: QueueItem,
    n: number,
    blob: Blob,
    onProgress: (loaded: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads/${item.id}/parts/${n}`);
      xhr.setRequestHeader('Authorization', `Upload ${item.capability}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = 900_000;
      const stop = () => xhr.abort();
      item.controller.signal.addEventListener('abort', stop, { once: true });
      const clear = () => item.controller.signal.removeEventListener('abort', stop);
      let last = 0;
      xhr.upload.onprogress = (e) => {
        const now = performance.now();
        if (now - last > 200 || e.loaded === e.total) {
          last = now;
          onProgress(e.loaded);
        }
      };
      xhr.onload = () => {
        clear();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let result: {
          error?: {
            code?: string;
            message?: string;
            retryable?: boolean;
            retryAfterSeconds?: number;
          };
        } = {};
        try {
          result = JSON.parse(xhr.responseText);
        } catch {
          /* Non-JSON edge errors. */
        }
        const e = result.error;
        reject(
          new ApiFailure(
            e?.code || 'PART_FAILED',
            e?.message || '연결을 다시 시도하고 있습니다.',
            e?.retryable || [408, 429, 500, 502, 503, 504].includes(xhr.status),
            e?.retryAfterSeconds,
            xhr.status,
          ),
        );
      };
      xhr.onerror = xhr.ontimeout = () => {
        clear();
        reject(new ApiFailure('NETWORK_ERROR', '인터넷 연결을 확인하고 있습니다.', true));
      };
      xhr.onabort = () => {
        clear();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      if (item.controller.signal.aborted) {
        clear();
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }
      xhr.send(blob);
    });
  }
  private async waitOnline(item: QueueItem): Promise<void> {
    if (navigator.onLine) return;
    const previous = item.state === 'offline' ? (item.id ? 'uploading' : 'creating') : item.state;
    item.state = 'offline';
    item.speed = 0;
    item.error = '인터넷 연결을 기다리고 있습니다. 이 화면을 열어 두세요.';
    this.emit();
    await new Promise<void>((resolve, reject) => {
      const signal = item.controller.signal;
      const finish = (error?: Error) => {
        clearInterval(timer);
        window.removeEventListener('online', check);
        signal.removeEventListener('abort', stop);
        if (error) reject(error);
        else resolve();
      };
      const stop = () => finish(new DOMException('Cancelled', 'AbortError'));
      const check = () => {
        if (signal.aborted) {
          stop();
          return;
        }
        if (item.expiresAt && Date.now() + (item.clockOffset || 0) >= item.expiresAt) {
          finish(
            new ApiFailure(
              'CAPABILITY_EXPIRED',
              '연결을 기다리는 동안 전송 권한이 만료되었습니다.',
            ),
          );
          return;
        }
        if (navigator.onLine) finish();
      };
      const timer = setInterval(check, 1000);
      signal.addEventListener('abort', stop, { once: true });
      window.addEventListener('online', check);
      check();
    });
    item.state = previous;
    item.error = undefined;
    this.emit();
  }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }
      const stop = () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, ms);
      signal.addEventListener('abort', stop, { once: true });
    });
  }
}
function messageForUpload(error: unknown) {
  return error instanceof Error ? error.message : '전송 결과를 확인하지 못했습니다.';
}
export const engine = new UploadEngine();
