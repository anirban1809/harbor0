export const TEXT_PREVIEW_BYTES = 1_000_000;
export type TextPreview = { text: string; truncated: boolean };

// Bound memory and network use even when the storage server ignores Range.
export async function fetchTextPreview(
  url: string,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<TextPreview> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES}` },
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (response.status === 416 && sizeBytes === 0) return { text: '', truncated: false };
  if (!response.ok || !response.body) throw new Error('Could not load the text preview.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let length = 0;
  let truncated = sizeBytes > TEXT_PREVIEW_BYTES;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = TEXT_PREVIEW_BYTES - length;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      length += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (text.includes('\0'))
    throw new Error('This file contains binary data and cannot be shown as text.');
  return { text, truncated };
}
