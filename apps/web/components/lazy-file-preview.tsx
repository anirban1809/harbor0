'use client';
import { lazy, Suspense, type ComponentProps } from 'react';
const Preview = lazy(() =>
  import('./file-preview').then((module) => ({ default: module.FilePreview })),
);

export function FilePreview(props: ComponentProps<typeof Preview>) {
  return (
    <Suspense fallback={<div role="status">Opening preview…</div>}>
      <Preview {...props} />
    </Suspense>
  );
}
