import type { Context } from 'hono';
import type { FileState } from '../shared/contracts';
export type AppEnv = { Bindings: Env; Variables: { requestId: string } };
export type AppContext = Context<AppEnv>;
export interface Principal {
  id: string;
  kind: 'device' | 'session';
  name: string | null;
  expiresAt: number | null;
}
export interface FileRow {
  id: string;
  mode: 'web_multipart' | 'shortcut_put';
  state: FileState;
  filename: string;
  declared_mime: string;
  size_bytes: number;
  retention_seconds: number;
  final_key: string;
  staging_key: string | null;
  multipart_id: string | null;
  capability_hash: string;
  capability_expires_at: number;
  owner_device_id: string | null;
  owner_session_id: string | null;
  created_at: number;
  last_activity_at: number;
  first_part_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
  actual_size_bytes: number | null;
  final_etag: string | null;
  pinned_source_etag: string | null;
  finalize_started_at: number | null;
  finalize_lease_until: number | null;
  cancel_requested_at: number | null;
  quota_bucket: 'reserved' | 'ready' | 'released';
}
export interface PartRow {
  file_id: string;
  part_number: number;
  state: 'SENDING' | 'DONE' | 'UNCERTAIN';
  bytes: number;
  etag: string | null;
  attempt_id: string;
  updated_at: number;
  lease_until: number | null;
  reconcile_token: string | null;
  reconcile_lease_until: number | null;
}
