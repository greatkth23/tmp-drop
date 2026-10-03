export type Page = 'download' | 'upload' | 'devices' | 'shortcuts';
export const routes: Record<Page, string> = {
  download: '/',
  upload: '/upload',
  devices: '/devices',
  shortcuts: '/shortcuts',
};
export const pageFromUrl = (): Page =>
  location.pathname === '/upload'
    ? 'upload'
    : location.pathname === '/devices'
      ? 'devices'
      : location.pathname === '/shortcuts'
        ? 'shortcuts'
        : 'download';
export function bytes(n: number) {
  for (const [unit, size] of [
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024],
  ] as const) {
    if (n >= size) return `${(n / size).toFixed(1)} ${unit}`;
  }
  return `${n} bytes`;
}
export function left(expires: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expires - now) / 1000));
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}시간 남음`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}분 남음`;
  return `${seconds}초 남음`;
}
export function countdown(expires: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expires - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function ago(time: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (!minutes) return '방금 완료';
  if (minutes < 60) return `${minutes}분 전 완료`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전 완료`;
  return `${Math.floor(minutes / 1440)}일 전 완료`;
}
export const retentionText = (n: number) => (n === 259200 ? '3일' : `${n / 3600}시간`);
export const dateTime = (n: number) =>
  new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(n);
