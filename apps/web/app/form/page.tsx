import { Suspense } from 'react';
import { FormPage } from '../../components/form-page';

export const metadata = { title: 'Form — harbor0' };

// Opened from a shared link or a campaign email, so it works without signing in.
export default function Page() {
  return (
    <Suspense>
      <FormPage />
    </Suspense>
  );
}
