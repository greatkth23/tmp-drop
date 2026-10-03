import type { FileSummary } from './contracts';
type NamedFile = Pick<FileSummary, 'filename' | 'completedAt' | 'id'>;
function representative(files: NamedFile[]) {
  return [...files].sort(
    (a, b) => b.completedAt - a.completedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )[0];
}
export function fileGroupLabel(files: NamedFile[]) {
  const first = representative(files);
  return first
    ? first.filename + (files.length > 1 ? ' 외 ' + (files.length - 1) + '개' : '')
    : '파일';
}
export function archiveFilename(files: NamedFile[]) {
  const first = representative(files);
  let base =
    (first?.filename || '파일')
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/[. ]+$/g, '') || '파일';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
  const suffix = (files.length > 1 ? ' 외 ' + (files.length - 1) + '개' : '') + '.zip';
  const encoder = new TextEncoder();
  const chars = Array.from(base);
  while (encoder.encode(chars.join('') + suffix).length > 255) chars.pop();
  return chars.join('') + suffix;
}
