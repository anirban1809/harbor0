import { afterEach, expect, it, vi } from 'vitest';
import { fetchTextPreview, TEXT_PREVIEW_BYTES } from '../src/preview';

afterEach(() => vi.unstubAllGlobals());
it('requests only a text prefix and preserves literal markup', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('<script>alert(1)</script>'));
  vi.stubGlobal('fetch', fetch);
  expect(await fetchTextPreview('https://storage.test/text', 25)).toEqual({
    text: '<script>alert(1)</script>',
    truncated: false,
  });
  expect(fetch.mock.calls[0][1].headers.Range).toBe(`bytes=0-${TEXT_PREVIEW_BYTES}`);
});
it('caps responses even when storage ignores Range and cancels the reader', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('a'.repeat(TEXT_PREVIEW_BYTES + 100)));
    },
    cancel,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
  const result = await fetchTextPreview('https://storage.test/large', 1);
  expect(result.text).toHaveLength(TEXT_PREVIEW_BYTES);
  expect(result.truncated).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});
it('does not truncate a file exactly at the byte limit', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('a'.repeat(TEXT_PREVIEW_BYTES))));
  expect((await fetchTextPreview('https://storage.test/exact', TEXT_PREVIEW_BYTES)).truncated).toBe(
    false,
  );
});
it('decodes UTF-8 characters split across network chunks', async () => {
  const bytes = new TextEncoder().encode('Hello 🌍');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 8));
            controller.enqueue(bytes.slice(8));
            controller.close();
          },
        }),
      ),
    ),
  );
  expect((await fetchTextPreview('https://storage.test/unicode', bytes.length)).text).toBe(
    'Hello 🌍',
  );
});
it('handles range rejection for empty files', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 416 })));
  expect(await fetchTextPreview('https://storage.test/empty', 0)).toEqual({
    text: '',
    truncated: false,
  });
});
it('rejects binary data and failed responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('binary\0data'))
      .mockResolvedValueOnce(new Response(null, { status: 403 })),
  );
  await expect(fetchTextPreview('https://storage.test/binary', 11)).rejects.toThrow('binary');
  await expect(fetchTextPreview('https://storage.test/expired', 11)).rejects.toThrow(
    'Could not load',
  );
});
it('passes cancellation through to the request', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn().mockRejectedValue(controller.signal.reason);
  vi.stubGlobal('fetch', fetch);
  await expect(
    fetchTextPreview('https://storage.test/text', 12, controller.signal),
  ).rejects.toThrow();
  expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
});
