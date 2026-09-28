// ZIP STORE + ZIP64 records, per PKWARE APPNOTE 6.3.10 sections 4.3 and 4.5.3.
// Records are independent of a writer instance so Lambda can checkpoint between
// chunks, including in the middle of a file, and resume in another invocation.
export type ZipEntry = { path: string; size: number; modified: string; directory: boolean };
const flags = 0x0808; // UTF-8 names, CRC/sizes follow the content in a descriptor.
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function name(entry: ZipEntry) {
  const bytes = new TextEncoder().encode(entry.path + (entry.directory ? '/' : ''));
  if (bytes.length > 65535) throw new Error('The ZIP entry path is too long.');
  return bytes;
}
function date(entry: ZipEntry, target: DataView, offset: number) {
  const d = new Date(entry.modified);
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  target.setUint16(
    offset,
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    true,
  );
  target.setUint16(
    offset + 2,
    ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    true,
  );
}
export function zipLocalHeader(entry: ZipEntry) {
  const filename = name(entry);
  const bytes = new Uint8Array(30 + filename.length + 20);
  const v = view(bytes);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 45, true);
  v.setUint16(6, flags, true);
  date(entry, v, 10);
  v.setUint32(18, 0xffffffff, true);
  v.setUint32(22, 0xffffffff, true);
  v.setUint16(26, filename.length, true);
  v.setUint16(28, 20, true);
  bytes.set(filename, 30);
  v.setUint16(30 + filename.length, 1, true);
  v.setUint16(32 + filename.length, 16, true);
  // With bit 3 set, sizes and CRC are supplied in the data descriptor.
  return bytes;
}
export function zipDescriptor(size: number, crc: number) {
  const bytes = new Uint8Array(24);
  const v = view(bytes);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, crc, true);
  v.setBigUint64(8, BigInt(size), true);
  v.setBigUint64(16, BigInt(size), true);
  return bytes;
}
export function zipCentralHeader(entry: ZipEntry, crc: number, offset: number) {
  const filename = name(entry);
  const bytes = new Uint8Array(46 + filename.length + 28);
  const v = view(bytes);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 45, true);
  v.setUint16(6, 45, true);
  v.setUint16(8, flags, true);
  date(entry, v, 12);
  v.setUint32(16, crc, true);
  v.setUint32(20, 0xffffffff, true);
  v.setUint32(24, 0xffffffff, true);
  v.setUint16(28, filename.length, true);
  v.setUint16(30, 28, true);
  v.setUint32(38, entry.directory ? 0x10 : 0, true);
  v.setUint32(42, 0xffffffff, true);
  bytes.set(filename, 46);
  const extra = 46 + filename.length;
  v.setUint16(extra, 1, true);
  v.setUint16(extra + 2, 24, true);
  v.setBigUint64(extra + 4, BigInt(entry.size), true);
  v.setBigUint64(extra + 12, BigInt(entry.size), true);
  v.setBigUint64(extra + 20, BigInt(offset), true);
  return bytes;
}
export function zipEnd(count: number, directoryOffset: number, directorySize: number) {
  const bytes = new Uint8Array(98);
  const v = view(bytes);
  v.setUint32(0, 0x06064b50, true);
  v.setBigUint64(4, 44n, true);
  v.setUint16(12, 45, true);
  v.setUint16(14, 45, true);
  v.setBigUint64(24, BigInt(count), true);
  v.setBigUint64(32, BigInt(count), true);
  v.setBigUint64(40, BigInt(directorySize), true);
  v.setBigUint64(48, BigInt(directoryOffset), true);
  v.setUint32(56, 0x07064b50, true);
  v.setBigUint64(64, BigInt(directoryOffset + directorySize), true);
  v.setUint32(72, 1, true);
  v.setUint32(76, 0x06054b50, true);
  v.setUint16(84, 0xffff, true);
  v.setUint16(86, 0xffff, true);
  v.setUint32(88, 0xffffffff, true);
  v.setUint32(92, 0xffffffff, true);
  return bytes;
}
