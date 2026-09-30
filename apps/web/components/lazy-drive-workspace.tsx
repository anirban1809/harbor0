'use client';
import { lazy, Suspense, type ComponentProps } from 'react';
import { FileCollectionSkeleton } from './file-collection';
const Workspace = lazy(() =>
  import('./drive-workspace').then((module) => ({ default: module.DriveWorkspace })),
);
export function DriveWorkspace(props: ComponentProps<typeof Workspace>) {
  return (
    <Suspense fallback={<FileCollectionSkeleton />}>
      <Workspace key={props.userId} {...props} />
    </Suspense>
  );
}
