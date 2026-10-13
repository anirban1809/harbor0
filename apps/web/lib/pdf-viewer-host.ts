/**
 * How the PDF viewer reaches pdf.js where the web's defaults do not work: the desktop app's
 * renderer loads from local files and may not fetch, so its main process supplies these.
 */
export type PdfViewerHost = {
  /** Starts pdf.js's worker. */
  worker: () => Worker;
  /** Reads a font, CMap or decoder file that pdf.js asks for, by its path under `pdfjs/`. */
  readAsset: (path: string) => Promise<Uint8Array>;
};

export let pdfViewerHost: PdfViewerHost | undefined;
/** Set once at startup, before any PDF is previewed. */
export function setPdfViewerHost(host: PdfViewerHost) {
  pdfViewerHost = host;
}
