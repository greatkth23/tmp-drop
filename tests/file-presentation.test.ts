import { expect, it, vi } from 'vitest';
import { listenFileDrop } from '../src/features/upload/fileDrop';
import { archiveFilename, fileGroupLabel } from '../shared/file-labels';
function drag(target: EventTarget, type: string, types = ['Files'], files: File[] = []) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  target.dispatchEvent(event);
  return event;
}
it('keeps the file overlay active across nested elements and clears it on exit', () => {
  const target = new EventTarget(),
    files = vi.fn(),
    active = vi.fn();
  const dispose = listenFileDrop(target, files, active);
  drag(target, 'dragenter');
  drag(target, 'dragenter');
  drag(target, 'dragleave');
  expect(active).not.toHaveBeenCalledWith(false);
  drag(target, 'dragleave');
  expect(active).toHaveBeenLastCalledWith(false);
  dispose();
});
it('accepts a drop once, ignores text drags, and removes listeners on unmount', () => {
  const target = new EventTarget(),
    files = vi.fn(),
    active = vi.fn();
  const dispose = listenFileDrop(target, files, active);
  expect(drag(target, 'dragenter', ['text/plain']).defaultPrevented).toBe(false);
  expect(active).not.toHaveBeenCalled();
  const file = new File(['fixture'], 'fixture.txt');
  drag(target, 'dragenter');
  expect(drag(target, 'dragover').defaultPrevented).toBe(true);
  expect(drag(target, 'drop', ['Files'], [file]).defaultPrevented).toBe(true);
  expect(files).toHaveBeenCalledExactlyOnceWith([file]);
  expect(active).toHaveBeenLastCalledWith(false);
  dispose();
  drag(target, 'drop', ['Files'], [file]);
  expect(files).toHaveBeenCalledTimes(1);
});
it('dismisses the drag overlay on Escape and window blur', () => {
  const target = new EventTarget(),
    active = vi.fn();
  const dispose = listenFileDrop(target, vi.fn(), active);
  drag(target, 'dragenter');
  const escape = new Event('keydown');
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  target.dispatchEvent(escape);
  expect(active).toHaveBeenLastCalledWith(false);
  drag(target, 'dragenter');
  target.dispatchEvent(new Event('blur'));
  expect(active).toHaveBeenLastCalledWith(false);
  dispose();
});
it('uses the visible newest filename and remaining count regardless of selection id order', () => {
  const old = { id: 'z', filename: 'old.png', completedAt: 1 },
    recent = { id: 'a', filename: '스크린샷.png', completedAt: 2 };
  expect(fileGroupLabel([old, recent])).toBe('스크린샷.png 외 1개');
  expect(archiveFilename([recent, old])).toBe('스크린샷.png 외 1개.zip');
  expect(archiveFilename([old, recent])).toBe(archiveFilename([recent, old]));
  expect(fileGroupLabel([recent])).toBe('스크린샷.png');
  expect(archiveFilename([recent])).toBe('스크린샷.png.zip');
});
it('keeps ZIP names portable and within the UTF-8 filename limit without losing the ZIP suffix', () => {
  const file = { id: '1', filename: '가'.repeat(85), completedAt: 1 };
  const name = archiveFilename([file, { ...file, id: '2' }]);
  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  expect(name.endsWith(' 외 1개.zip')).toBe(true);
  expect(archiveFilename([{ ...file, filename: 'CON' }])).toBe('_CON.zip');
  expect(archiveFilename([{ ...file, filename: 'a/b\\c\r\n?.png' }])).not.toMatch(/[\\/\r\n?]/);
});
