import { mutate } from '../../api';
import { engine } from '../../uploader';
import { createDeletionJobs } from './deletionJobsCore';
import type { DeleteResult } from './deletionJobsCore';
export const deletionJobs = createDeletionJobs(
  async (files, batch, grant) => {
    const headers: Record<string, string> = grant ? { 'X-Admin-Grant': grant } : {};
    if (batch)
      return (
        await mutate<{ results: DeleteResult[] }>(
          '/api/files/delete',
          { ids: files.map((f) => f.id) },
          'POST',
          headers,
        )
      ).results;
    const result = await mutate<{ state: string }>(
      `/api/files/${files[0].id}`,
      {},
      'DELETE',
      headers,
    );
    return [{ id: files[0].id, state: result.state }];
  },
  (id) => engine.markDeleted(id),
);
