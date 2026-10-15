import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from 'lucide-react';

type Entry = { type: 'FILE' | 'FOLDER'; name: string; mimeType?: string | null };
const byExtension: Record<string, LucideIcon> = {
  zip: FileArchive,
  rar: FileArchive,
  '7z': FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  csv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  numbers: FileSpreadsheet,
  pdf: FileText,
  txt: FileText,
  md: FileText,
  doc: FileText,
  docx: FileText,
  rtf: FileText,
  pages: FileText,
  json: FileCode,
  js: FileCode,
  ts: FileCode,
  html: FileCode,
  css: FileCode,
  py: FileCode,
  sh: FileCode,
};

/**
 * The icon for a file or folder, and the colour family its tile uses (`data-kind` on
 * `.file-entry-icon`): by MIME type first, then by extension for files stored without one.
 */
export function fileIcon(item: Entry): { Icon: LucideIcon; kind: 'folder' | 'image' | 'document' } {
  if (item.type === 'FOLDER') return { Icon: Folder, kind: 'folder' };
  const mime = item.mimeType ?? '';
  const extension = item.name.includes('.') ? item.name.split('.').at(-1)!.toLowerCase() : '';
  if (
    mime.startsWith('image/') ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(extension)
  )
    return { Icon: FileImage, kind: 'image' };
  if (mime.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm'].includes(extension))
    return { Icon: FileVideo, kind: 'document' };
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a'].includes(extension))
    return { Icon: FileAudio, kind: 'document' };
  return {
    Icon: byExtension[extension] ?? (mime.startsWith('text/') ? FileText : File),
    kind: 'document',
  };
}
