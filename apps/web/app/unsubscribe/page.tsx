import { Suspense } from 'react';
import { UnsubscribePage } from '../../components/unsubscribe-page';

export const metadata = { title: 'Email preferences — harbor0' };

// Opened from the unsubscribe link in an email, so it works without signing in.
export default function Page() {
  return (
    <Suspense>
      <UnsubscribePage />
    </Suspense>
  );
}
