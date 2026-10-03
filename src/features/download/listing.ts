import type { FileSummary } from '../../../shared/contracts';
import { api } from '../../api';
export type Listing = { files: FileSummary[]; nextCursor: string | null; serverNow: number };
// Rebuild every loaded page before committing a refresh, even when records were inserted/deleted.
export async function readFilePages(count: number, signal: AbortSignal): Promise<Listing> {
  const collected = new Map<string, FileSummary>();
  let nextCursor: string | null = null,
    serverNow = 0;
  for (let page = 0; page < count; page++) {
    const result: Listing = await api<Listing>(
      '/api/files' + (nextCursor ? '?cursor=' + encodeURIComponent(nextCursor) : ''),
      { signal },
    );
    for (const file of result.files) collected.set(file.id, file);
    nextCursor = result.nextCursor;
    serverNow = result.serverNow;
    if (!nextCursor) break;
  }
  return { files: [...collected.values()], nextCursor, serverNow };
}
