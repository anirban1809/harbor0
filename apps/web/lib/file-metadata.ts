import type { DriveItem } from '@harbor/contracts';
export type FileEntry = Pick<DriveItem, 'id' | 'name' | 'type' | 'sizeBytes'> &
  Partial<
    Pick<
      DriveItem,
      'mimeType' | 'ownerUserId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'favorite'
    >
  >;
export function fileSize(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return '—';
  if (size < 1000) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${units[unit]}`;
}
export function fileKind(item: FileEntry): string {
  if (item.type === 'FOLDER') return 'Folder';
  const extension = item.name.includes('.') ? item.name.split('.').at(-1)!.toLowerCase() : '';
  const known: Record<string, string> = {
    pdf: 'PDF document',
    md: 'Markdown document',
    txt: 'Text document',
    doc: 'Word document',
    docx: 'Word document',
    xls: 'Spreadsheet',
    xlsx: 'Spreadsheet',
    csv: 'CSV spreadsheet',
    ppt: 'Presentation',
    pptx: 'Presentation',
    zip: 'ZIP archive',
    json: 'JSON file',
  };
  if (Object.hasOwn(known, extension)) return known[extension];
  const type = item.mimeType?.split('/')[0];
  if (['image', 'video', 'audio'].includes(type ?? ''))
    return `${extension ? extension.toUpperCase() + ' ' : ''}${type}`;
  return extension ? `${extension.toUpperCase()} file` : 'File';
}
export function fileDate(value?: string | null) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime()))
    return { date: '—', time: '', full: 'Date unavailable' };
  return {
    date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    full: date.toLocaleString(),
  };
}
export function fileSummary(items: FileEntry[]) {
  const files = items.filter((item) => item.type === 'FILE');
  const folders = items.length - files.length;
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} · ${folders} ${folders === 1 ? 'folder' : 'folders'} · ${fileSize(files.reduce((sum, item) => sum + Math.max(0, item.sizeBytes || 0), 0))} in shown files`;
}
