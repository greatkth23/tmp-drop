import { canPreviewImage } from '../../../shared/preview';
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
    <label className="file-select">
      <input
        ref={ref}
        className="file-check"
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
    </label>
  );
}
interface GroupedFilesProps {
  files: FileSummary[];
  selected: Set<string>;
  toggle: (ids: string[]) => void;
  onDelete: (file: FileSummary) => void;
  onDownloadGroup: (files: FileSummary[]) => void;
  onDeleteGroup: (files: FileSummary[]) => void;
  zipping: boolean;
  now: number;
  connected: boolean;
}
function Expiry({
  expiresAt,
  now,
  group = false,
}: {
  expiresAt: number;
  now: number;
  group?: boolean;
}) {
  return (
    <div className={`expiry ${expiresAt - now < 3600_000 ? 'soon' : ''}`}>
      <span>
        <Icon name="clock" size={14} />
        {group ? '첫 만료 · ' : ''}
        {left(expiresAt, now)}
      </span>
      <small>{dateTime(expiresAt)}</small>
    </div>
  );
}
function FileRow({
  file: f,
  nested = false,
  selected,
  toggle,
  onDelete,
  now,
  connected,
}: Omit<GroupedFilesProps, 'files'> & { file: FileSummary; nested?: boolean }) {
  return (
    <article
      className={`download-row selectable-row ${nested ? 'nested-file-row' : 'top-level-row'}`}
    >
      <span className="group-toggle-space" aria-hidden="true" />
      <FileIdentity
        name={f.filename}
        detail={ago(f.completedAt, now)}
        previewSrc={
          canPreviewImage(f.filename, f.sizeBytes) ? `/api/files/${f.id}/preview` : undefined
        }
      />
      <div className="file-details">
        <span className="download-size">{bytes(f.sizeBytes)}</span>
        <Expiry expiresAt={f.expiresAt} now={now} />
      </div>
      <div className="download-actions">
        <a
          className="btn secondary small"
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
      <SelectBox
        label={`${f.filename} 선택`}
        checked={selected.has(f.id)}
        onChange={() => toggle([f.id])}
      />
    </article>
  );
}
function FileGroup(props: GroupedFilesProps) {
  const { files, selected, toggle, onDownloadGroup, onDeleteGroup, zipping, now, connected } =
    props;
  const [open, setOpen] = useState(false),
    id = useId();
  if (files.length === 1)
    return (
      <section className="file-group">
        <FileRow {...props} file={files[0]} />
      </section>
    );
  const count = files.filter((f) => selected.has(f.id)).length;
  const latest = Math.max(...files.map((f) => f.completedAt));
  const expiresAt = Math.min(...files.map((f) => f.expiresAt));
  const name = dateTime(latest) + ' 업로드 묶음';
  return (
    <section className="file-group">
      <div
        className="download-row selectable-row top-level-row group-head"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('button, a, input, label'))
            return;
          setOpen((previous) => !previous);
        }}
      >
        <button
          className="group-toggle icon-button"
          aria-label={`${name} ${files.length}개 파일 ${open ? '접기' : '펼치기'}`}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={22} />
        </button>
        <FileIdentity
          name={name}
          icon="folder"
          detail={`${files.length}개 파일 · ${ago(latest, now)}${count ? ' · ' + count + '개 선택' : ''}`}
        />
        <div className="file-details">
          <span className="download-size">
            {bytes(files.reduce((sum, f) => sum + f.sizeBytes, 0))}
          </span>
          <Expiry expiresAt={expiresAt} now={now} group />
        </div>
        <div className="download-actions">
          <button
            className="btn secondary small"
            disabled={!connected || zipping}
            aria-label={`${name} ${files.length}개 파일 ZIP 다운로드`}
            onClick={() => onDownloadGroup(files)}
          >
            <Icon name="download" size={18} />
            다운로드
          </button>
          <button
            className="btn quiet small danger-text"
            disabled={!connected}
            aria-label={`${name} ${files.length}개 파일 삭제`}
            onClick={() => onDeleteGroup(files)}
          >
            <Icon name="trash" size={17} />
            삭제
          </button>
        </div>
        <SelectBox
          label={`이 묶음 ${files.length}개 파일 전체 선택`}
          checked={count === files.length}
          mixed={count > 0 && count < files.length}
          onChange={() => toggle(files.map((f) => f.id))}
        />
      </div>
      <div id={id} className="group-children" hidden={!open}>
        {files.map((f) => (
          <FileRow key={f.id} {...props} file={f} nested />
        ))}
      </div>
    </section>
  );
}
export function GroupedFiles(props: GroupedFilesProps) {
  return (
    <>
      {groupFiles(props.files).map(([key, files]) => (
        <FileGroup key={key} {...props} files={files} />
      ))}
    </>
  );
}
