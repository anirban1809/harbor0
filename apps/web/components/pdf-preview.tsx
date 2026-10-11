'use client';
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { Button } from './ui/button';

// Fonts, CMaps and decoders are copied to /pdfjs by scripts/copy-pdfjs.mjs.
const assets = '/pdfjs/';
const zoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
// Browsers fail to draw very large canvases; cap each page's backing store.
const maxCanvasPixels = 16_000_000;

let worker: PDFWorker | undefined;
async function pdfjs() {
  const module = await import('pdfjs-dist');
  // One worker is shared by every preview. Documents given an existing worker do not
  // own it, so closing a preview leaves it running for the next one.
  worker ??= module.PDFWorker.create({
    port: new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
      type: 'module',
    }),
  });
  return { ...module, worker };
}

export function PdfPreview({
  url,
  name,
  onReady,
  onError,
}: {
  url: string;
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
    let cancelled = false;
    let destroy = () => {};
    void pdfjs()
      .then(async ({ getDocument, PasswordException, worker }) => {
        const task = getDocument({
          url,
          worker,
          cMapUrl: `${assets}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${assets}standard_fonts/`,
          wasmUrl: `${assets}wasm/`,
          iccUrl: `${assets}iccs/`,
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
    // The callbacks only report status; a new URL is what restarts loading.
  }, [url]);
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
  if (!doc) return null;
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
