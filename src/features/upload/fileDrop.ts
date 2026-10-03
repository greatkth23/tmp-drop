type FileDragEvent = Event & {
  dataTransfer?: {
    types: ArrayLike<string>;
    files: ArrayLike<File>;
    dropEffect: string;
  } | null;
};
// Native file drags enter/leave nested DOM nodes; depth prevents overlay flicker.
export function listenFileDrop(
  target: EventTarget,
  onFiles: (files: File[]) => void,
  onActive: (active: boolean) => void,
) {
  let depth = 0;
  const hasFiles = (event: FileDragEvent) =>
    Array.from(event.dataTransfer?.types || []).includes('Files');
  const reset = () => {
    depth = 0;
    onActive(false);
  };
  const enter = (event: Event) => {
    const e = event as FileDragEvent;
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    onActive(true);
  };
  const over = (event: Event) => {
    const e = event as FileDragEvent;
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const leave = () => {
    if (depth && --depth === 0) onActive(false);
  };
  const drop = (event: Event) => {
    const e = event as FileDragEvent;
    if (!hasFiles(e)) {
      reset();
      return;
    }
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    reset();
    if (files.length) onFiles(files);
  };
  const key = (event: Event) => {
    if ((event as Event & { key?: string }).key === 'Escape') reset();
  };
  const handlers: [string, EventListener][] = [
    ['dragenter', enter],
    ['dragover', over],
    ['dragleave', leave],
    ['drop', drop],
    ['dragend', reset],
    ['blur', reset],
    ['keydown', key],
  ];
  for (const [name, handler] of handlers) target.addEventListener(name, handler);
  return () => {
    for (const [name, handler] of handlers) target.removeEventListener(name, handler);
  };
}
