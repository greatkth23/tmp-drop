import { useEffect, useId, useRef, useState } from 'react';
import type { FileSummary } from '../../../shared/contracts';
import { Icon } from '../../components/Icon';
import { FileIdentity } from '../../components/Ui';
import { ago, bytes, dateTime, left } from '../../lib/format';

export function groupFiles(files: FileSummary[]) {
  const groups = new Map<string, FileSummary[]>();
  for (const file of files) {
    const key = file.batchId || file.id;
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }
  return [...groups].sort(
    (a, b) =>
      Math.max(...b[1].map((f) => f.completedAt)) - Math.max(...a[1].map((f) => f.completedAt)),
  );
}
export function SelectBox({
  label,
  checked,
  mixed,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      className="file-check"
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
function FileGroup({
  files,
  selected,
  toggle,
  onDelete,
  now,
  connected,
}: {
  files: FileSummary[];
  selected: Set<string>;
  toggle: (ids: string[]) => void;
  onDelete: (file: FileSummary) => void;
  now: number;
  connected: boolean;
}) {
  const [open, setOpen] = useState(!files[0].batchId),
    id = useId();
  const count = files.filter((f) => selected.has(f.id)).length,
    latest = Math.max(...files.map((f) => f.completedAt));
  return (
    <section className="file-group">
      <div className="group-head">
        <SelectBox
          label={`이 묶음 ${files.length}개 파일 전체 선택`}
          checked={count === files.length}
          mixed={count > 0 && count < files.length}
          onChange={() => toggle(files.map((f) => f.id))}
        />
        <button
          className="group-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <span className="group-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span>
            <strong>{files[0].batchId ? `${dateTime(latest)} 업로드` : files[0].filename}</strong>
            <small>
              {files.length}개 · {bytes(files.reduce((s, f) => s + f.sizeBytes, 0))}
              {count > 0 ? ` · ${count}개 선택` : ''}
            </small>
          </span>
          <span className="group-toggle-label">{open ? '접기' : '펼치기'}</span>
        </button>
      </div>
      <div id={id} hidden={!open}>
        {files.map((f) => (
          <article className="download-row selectable-row" key={f.id}>
            <SelectBox
              label={`${f.filename} 선택`}
              checked={selected.has(f.id)}
              onChange={() => toggle([f.id])}
            />
            <FileIdentity name={f.filename} detail={ago(f.completedAt, now)} />
            <span className="download-size">{bytes(f.sizeBytes)}</span>
            <div className={`expiry ${f.expiresAt - now < 3600_000 ? 'soon' : ''}`}>
              <span>
                <Icon name="clock" size={14} />
                {left(f.expiresAt, now)}
              </span>
              <small>{dateTime(f.expiresAt)}</small>
            </div>
            <div className="download-actions">
              <a
                className="btn primary small"
                href={`/api/files/${f.id}/download`}
                target="_blank"
                rel="noreferrer"
                aria-label={`${f.filename} 다운로드`}
              >
                <Icon name="download" size={18} />
                다운로드
              </a>
              <button
                className="btn quiet small danger-text"
                disabled={!connected}
                aria-label={`${f.filename} 삭제`}
                onClick={() => onDelete(f)}
              >
                <Icon name="trash" size={17} />
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
export function GroupedFiles(props: {
  files: FileSummary[];
  selected: Set<string>;
  toggle: (ids: string[]) => void;
  onDelete: (file: FileSummary) => void;
  now: number;
  connected: boolean;
}) {
  return (
    <>
      {groupFiles(props.files).map(([key, files]) => (
        <FileGroup key={key} {...props} files={files} />
      ))}
    </>
  );
}
