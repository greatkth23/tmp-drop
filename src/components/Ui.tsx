import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
export function ErrorText({ error, id }: { error?: string; id?: string }) {
  return error ? (
    <p className="error" role="alert" id={id}>
      <Icon name="warning" size={18} />
      <span>{error}</span>
    </p>
  ) : null;
}
export function PageHead({
  title,
  body,
  right,
}: {
  title: string;
  body: string;
  right?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{body}</p>
      </div>
      {right && <div className="page-actions">{right}</div>}
    </div>
  );
}
export function FileIdentity({ name, detail }: { name: string; detail?: ReactNode }) {
  return (
    <div className="file-identity">
      <span className="file-icon">
        <Icon name="file" size={24} />
      </span>
      <div className="file-info">
        <strong className="filename">{name}</strong>
        {detail && <span className="filemeta">{detail}</span>}
      </div>
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  fallbackFocus = 'main h1',
  initialFocus = 'heading',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  fallbackFocus?: string;
  initialFocus?: 'heading' | 'input';
}) {
  const ref = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    id = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    if (initialFocus === 'heading') heading.current?.focus();
    else dialog?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(fallbackFocus)?.focus();
    };
  }, [fallbackFocus, initialFocus]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id={id} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
