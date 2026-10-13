'use client';
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { Button } from './ui/button';
import type { ReadRange } from '../lib/file-preview';
import { pdfViewerHost } from '../lib/pdf-viewer-host';

// Fonts, CMaps and decoders are copied to /pdfjs by scripts/copy-pdfjs.mjs.
const assets = '/pdfjs/';
const zoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
// Browsers fail to draw very large canvases; cap each page's backing store.
const maxCanvasPixels = 16_000_000;
// Smaller files load in one request; larger ones are read in ranges as pages are needed.
const wholeFileBytes = 2 * 1024 * 1024;
const rangeChunkBytes = 256 * 1024;
// The header and first page usually sit at the start and the cross-reference table at the
// end, so both are requested together as soon as the link is known.
const tailBytes = 2 * rangeChunkBytes;
// Up to this size, a file that needs more than its start and end is fetched whole: some
// files make pdf.js read most of them a chunk at a time, one round trip each.
const fetchRestBytes = 16 * 1024 * 1024;
// Larger files read further ahead each time pdf.js reads on from where it stopped.
const maxReadAheadBytes = 4 * 1024 * 1024;

let worker: PDFWorker | undefined;
async function pdfjs() {
  const module = await import('pdfjs-dist');
  // One worker is shared by every preview. Documents given an existing worker do not
  // own it, so closing a preview leaves it running for the next one.
  worker ??= module.PDFWorker.create({
    port: pdfViewerHost
      ? pdfViewerHost.worker()
      : new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
          type: 'module',
        }),
  });
  return { ...module, worker };
}

/** Loads pdf.js and starts its worker ahead of time, so opening a PDF starts at once. */
export function preloadPdfViewer() {
  void pdfjs().catch(() => {});
}

// Where pdf.js's data files live, by the option that names them.
const assetDirectories = {
  cMapUrl: 'cmaps/',
  standardFontDataUrl: 'standard_fonts/',
  wasmUrl: 'wasm/',
} as const;
/** pdf.js options for its fonts, CMaps and decoders: fetched from /pdfjs, or read by the host. */
function assetOptions() {
  const host = pdfViewerHost;
  const urls = {
    cMapUrl: `${assets}${assetDirectories.cMapUrl}`,
    standardFontDataUrl: `${assets}${assetDirectories.standardFontDataUrl}`,
    wasmUrl: `${assets}${assetDirectories.wasmUrl}`,
  };
  if (!host) return { ...urls, iccUrl: `${assets}iccs/`, cMapPacked: true };
  return {
    ...urls,
    cMapPacked: true,
    // The worker cannot fetch these itself, so it asks this page, which asks the host.
    useWorkerFetch: false,
    BinaryDataFactory: class {
      fetch({ kind, filename }: { kind: keyof typeof assetDirectories; filename: string }) {
        return host.readAsset(`${assetDirectories[kind]}${filename}`);
      }
    },
  };
}

/**
 * Reads byte ranges through a download link. pdf.js only asks for ranges itself when it can
 * read `Accept-Ranges`, which the storage CORS rules do not expose, so ranges are fetched here.
 * Download links expire after a few minutes; an expired link is renewed once and retried.
 */
export function linkRanges(initialUrl: string, renew: () => Promise<string>): ReadRange {
  let url = initialUrl;
  let renewing: Promise<string> | undefined;
  const read = async (begin: number, end: number, retry = true): Promise<Uint8Array> => {
    const used = url;
    const response = await fetch(used, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (response.status === 403 && retry) {
      if (url === used)
        url = await (renewing ??= renew().finally(() => {
          renewing = undefined;
        }));
      return read(begin, end, false);
    }
    if (!response.ok) throw new Error(`Range request failed with ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    // A server that ignores Range sends the whole file.
    return response.status === 206 ? data : data.subarray(begin, end);
  };
  return (begin, end) => read(begin, end);
}

/** Decides how much to read for each request pdf.js makes, so few round trips are needed. */
function rangeReader(fetchRange: ReadRange, size: number) {
  // Ranges fetched before or beyond what pdf.js asked for; reused when one covers a request.
  const ahead: { begin: number; end: number; data: Promise<Uint8Array> }[] = [];
  const prefetch = (begin: number, end: number) => {
    const range = { begin, end, data: fetchRange(begin, end) };
    range.data.catch(() => {});
    ahead.push(range);
    return range;
  };
  let lastEnd = -1;
  let streak = 0;
  return {
    prefetch,
    async read(begin: number, end: number) {
      const sequential = begin === lastEnd;
      lastEnd = end;
      let hit = ahead.find((range) => range.begin <= begin && end <= range.end);
      if (!hit && size <= fetchRestBytes) hit = prefetch(0, size);
      else if (!hit) {
        streak = sequential ? streak + 1 : 0;
        const until = Math.min(
          size,
          Math.max(end, begin + Math.min(maxReadAheadBytes, rangeChunkBytes * 2 ** streak)),
        );
        hit = prefetch(begin, until);
      }
      const data = await hit.data.catch(() => undefined);
      return data ? data.subarray(begin - hit.begin, end - hit.begin) : fetchRange(begin, end);
    },
  };
}

export function PdfPreview({
  read,
  size,
  name,
  onReady,
  onError,
}: {
  /** Undefined until the file can be read, e.g. while its download link is fetched. */
  read: ReadRange | undefined;
  size: number;
  name: string;
  onReady: () => void;
  onError: (message?: string) => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [ratio, setRatio] = useState(Math.SQRT2);
  const [zoom, setZoom] = useState(2);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!read) return;
    let cancelled = false;
    let destroy = () => {};
    // Start reading before pdf.js has loaded, in case it was not preloaded.
    const ranges = rangeReader(read, size);
    if (size <= wholeFileBytes) {
      if (size > 0) ranges.prefetch(0, size);
    } else {
      const tail = Math.floor((size - tailBytes) / rangeChunkBytes) * rangeChunkBytes;
      ranges.prefetch(0, rangeChunkBytes);
      ranges.prefetch(tail, size);
    }
    void pdfjs()
      .then(async ({ getDocument, PasswordException, PDFDataRangeTransport, worker }) => {
        let source;
        if (size > wholeFileBytes) {
          const transport = new PDFDataRangeTransport(size, null);
          transport.requestDataRange = (begin, end) =>
            void ranges.read(begin, end).then(
              (chunk) => {
                // pdf.js throws for a request it has since dropped, e.g. once the tray closed.
                if (cancelled) return;
                try {
                  transport.onDataRange(begin, chunk);
                } catch {}
              },
              () => {
                if (!cancelled) onError();
              },
            );
          source = { range: transport };
        } else {
          source = { data: size > 0 ? await ranges.read(0, size) : new Uint8Array() };
        }
        if (cancelled) return;
        const task = getDocument({
          ...source,
          ...assetOptions(),
          rangeChunkSize: rangeChunkBytes,
          // Fetch only what the visible pages need instead of the rest in the background.
          disableAutoFetch: true,
          disableStream: true,
          worker,
          enableXfa: false,
        });
        destroy = () => void task.destroy();
        if (cancelled) return destroy();
        try {
          const loaded = await task.promise;
          const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
          if (cancelled) return;
          setRatio(first.height / first.width);
          setDoc(loaded);
          onReady();
        } catch (e) {
          if (cancelled) return;
          onError(
            e instanceof PasswordException
              ? 'This PDF is password-protected. Download it to open it on your device.'
              : undefined,
          );
        }
      })
      .catch(() => {
        if (!cancelled) onError();
      });
    return () => {
      cancelled = true;
      destroy();
    };
    // The callbacks only report status; a new reader is what restarts loading.
  }, [read]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setWidth(
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      );
    };
    // Measure now too: hidden tabs hold resize callbacks until their next frame.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [doc]);
  if (!doc)
    return (
      <div className="file-preview-pdf" role="status" aria-label="Loading preview">
        <div className="file-preview-pdf-toolbar">
          <span>Loading…</span>
        </div>
        <div className="file-preview-pdf-pages">
          <div className="file-preview-pdf-page file-preview-pdf-placeholder" />
        </div>
      </div>
    );
  const pageWidth = Math.floor(width * zoomSteps[zoom]);
  return (
    <div className="file-preview-pdf">
      <div className="file-preview-pdf-toolbar">
        <span>
          {doc.numPages} {doc.numPages === 1 ? 'page' : 'pages'}
        </span>
        <div className="file-preview-pdf-zoom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            disabled={zoom === 0}
            onClick={() => setZoom((value) => Math.max(0, value - 1))}
          >
            <Minus />
          </Button>
          <button
            type="button"
            className="file-preview-pdf-level"
            aria-label="Fit to width"
            onClick={() => setZoom(2)}
          >
            {Math.round(zoomSteps[zoom] * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            disabled={zoom === zoomSteps.length - 1}
            onClick={() => setZoom((value) => Math.min(zoomSteps.length - 1, value + 1))}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div
        ref={scroller}
        className="file-preview-pdf-pages"
        tabIndex={0}
        role="document"
        aria-label={`PDF preview: ${name}`}
      >
        {width > 0 &&
          Array.from({ length: doc.numPages }, (_, index) => (
            <PdfPage
              key={index}
              doc={doc}
              number={index + 1}
              width={pageWidth}
              ratio={ratio}
              root={scroller}
            />
          ))}
      </div>
    </div>
  );
}

/** Draws a page while it is near the viewport and frees its canvas once it scrolls away. */
function PdfPage({
  doc,
  number,
  width,
  ratio: initialRatio,
  root,
}: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  ratio: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(initialRatio);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: root.current,
      rootMargin: '100% 0px',
    });
    observer.observe(frame.current!);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const element = canvas.current!;
    if (!visible) {
      element.width = element.height = 0;
      return;
    }
    let render: { cancel: () => void } | undefined;
    let cancelled = false;
    void doc
      .getPage(number)
      .then((page) => {
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        const scale = width / base.width;
        const density = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(maxCanvasPixels / (base.width * base.height * scale * scale)),
        );
        const viewport = page.getViewport({ scale: scale * density });
        element.width = Math.floor(viewport.width);
        element.height = Math.floor(viewport.height);
        const task = page.render({ canvas: element, viewport });
        render = task;
        return task.promise;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, number, width, visible]);
  return (
    <div
      ref={frame}
      className="file-preview-pdf-page"
      style={{ width, height: Math.round(width * ratio) }}
    >
      <canvas ref={canvas} aria-label={`Page ${number}`} />
    </div>
  );
}
