'use client';
import { lazy, Suspense, useEffect, useState, type ComponentProps } from 'react';
import type { FileEntry } from '../lib/file-metadata';
import { previewKind } from '../lib/file-preview';

type Module = typeof import('./file-preview');
let loaded: Module | undefined;
const load = () => import('./file-preview').then((module) => (loaded = module));
const Preview = lazy(() => load().then((module) => ({ default: module.FilePreview })));

const preloadPdfViewer = () => {
  void load();
  void import('./pdf-preview').then((module) => module.preloadPdfViewer());
};

/** Loads the PDF viewer while the browser is idle once a PDF is listed, so opening one starts at once. */
export function usePdfPreload(enabled: boolean, items: readonly FileEntry[]) {
  const listed = enabled && items.some((item) => previewKind(item) === 'pdf');
  useEffect(() => {
    if (!listed) return;
    if (!('requestIdleCallback' in window)) return void setTimeout(preloadPdfViewer, 1000);
    const id = requestIdleCallback(preloadPdfViewer, { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }, [listed]);
}

export function FilePreview(props: ComponentProps<Module['FilePreview']>) {
  // Once loaded, render it directly: suspending would hold the tray back for a moment.
  // Chosen once per tray, so loading meanwhile never remounts an open one.
  const [module] = useState(() => loaded);
  if (module) return <module.FilePreview {...props} />;
  return (
    <Suspense fallback={<div role="status">Opening preview…</div>}>
      <Preview {...props} />
    </Suspense>
  );
}
