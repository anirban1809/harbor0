import { Suspense } from 'react';
import { SurveyPage } from '../../components/survey-page';

export const metadata = { title: 'Survey — harbor0' };

// Opened from the survey in a campaign email, so it works without signing in.
export default function Page() {
  return (
    <Suspense>
      <SurveyPage />
    </Suspense>
  );
}
