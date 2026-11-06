import type { FileRow } from './types';
import { crc32 } from 'node:zlib';

const encoder = new TextEncoder();
function record(size: number) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return {
    bytes,
    u16: (p: number, n: number) => view.setUint16(p, n, true),
    u32: (p: number, n: number) => view.setUint32(p, n, true),
    u64: (p: number, n: bigint) => view.setBigUint64(p, n, true),
  };
}
// A ZIP entry must be a portable basename; duplicate names must not overwrite each other.
export function archiveNames(files: Pick<FileRow, 'filename'>[]): string[] {
  const used = new Set<string>();
  return files.map((file) => {
    let base =
      file.filename
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
        .replace(/[. ]+$/g, '') || 'file';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
    const dot = base.lastIndexOf('.'),
      stem = dot > 0 ? base.slice(0, dot) : base,
      ext = dot > 0 ? base.slice(dot) : '';
    let name = base,
      n = 2;
    while (used.has(name.toLowerCase())) name = `${stem} (${n++})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// ZIP64 STORE: bounded memory, no recompression, backpressure from the browser to R2.
export function archiveStream(bucket: R2Bucket, files: FileRow[]): ReadableStream<Uint8Array> {
  const names = archiveNames(files);
  async function* generate() {
    let offset = 0n;
    const directory: Uint8Array[] = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index],
        name = encoder.encode(names[index]),
        start = offset,
        size = BigInt(file.size_bytes);
      const object = await bucket.get(
        file.final_key,
        file.final_etag
          ? { onlyIf: { etagMatches: file.final_etag.replaceAll('"', '') } }
          : undefined,
      );
      if (!object || !('body' in object) || object.size !== file.size_bytes)
        throw new Error('Archive source unavailable');
      const reader = object.body.getReader();
      try {
        const h = record(30 + name.length + 20);
        h.u32(0, 0x04034b50);
        h.u16(4, 45);
        h.u16(6, 0x0808);
        h.u16(12, 33);
        h.u32(18, 0xffffffff);
        h.u32(22, 0xffffffff);
        h.u16(26, name.length);
        h.u16(28, 20);
        h.bytes.set(name, 30);
        h.u16(30 + name.length, 1);
        h.u16(32 + name.length, 16);
        h.u64(34 + name.length, size);
        h.u64(42 + name.length, size);
        offset += BigInt(h.bytes.length);
        yield h.bytes;
        let crc = 0,
          count = 0n;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          count += BigInt(value.length);
          if (count > size) throw new Error('Archive source size changed');
          crc = crc32(value, crc);
          offset += BigInt(value.length);
          yield value;
        }
        if (count !== size) throw new Error('Archive source truncated');
        const descriptor = record(24);
        descriptor.u32(0, 0x08074b50);
        descriptor.u32(4, crc);
        descriptor.u64(8, size);
        descriptor.u64(16, size);
        offset += 24n;
        yield descriptor.bytes;
        const c = record(46 + name.length + 28);
        c.u32(0, 0x02014b50);
        c.u16(4, 45);
        c.u16(6, 45);
        c.u16(8, 0x0808);
        c.u16(14, 33);
        c.u32(16, crc);
        c.u32(20, 0xffffffff);
        c.u32(24, 0xffffffff);
        c.u16(28, name.length);
        c.u16(30, 28);
        c.u32(42, 0xffffffff);
        c.bytes.set(name, 46);
        c.u16(46 + name.length, 1);
        c.u16(48 + name.length, 24);
        c.u64(50 + name.length, size);
        c.u64(58 + name.length, size);
        c.u64(66 + name.length, start);
        directory.push(c.bytes);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const directoryStart = offset;
    for (const bytes of directory) {
      offset += BigInt(bytes.length);
      yield bytes;
    }
    const end = record(56);
    end.u32(0, 0x06064b50);
    end.u64(4, 44n);
    end.u16(12, 45);
    end.u16(14, 45);
    end.u64(24, BigInt(files.length));
    end.u64(32, BigInt(files.length));
    end.u64(40, offset - directoryStart);
    end.u64(48, directoryStart);
    yield end.bytes;
    const locator = record(20);
    locator.u32(0, 0x07064b50);
    locator.u64(8, offset);
    locator.u32(16, 1);
    yield locator.bytes;
    const tail = record(22);
    tail.u32(0, 0x06054b50);
    tail.u16(8, 0xffff);
    tail.u16(10, 0xffff);
    tail.u32(12, 0xffffffff);
    tail.u32(16, 0xffffffff);
    yield tail.bytes;
  }
  const iterator = generate();
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const item = await iterator.next();
          if (item.done) controller.close();
          else controller.enqueue(item.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
