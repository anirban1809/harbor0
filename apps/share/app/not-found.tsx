import { Chrome } from './chrome';

export default function NotFound() {
  return (
    <Chrome>
      <section className="share-card">
        <h1>Page not found</h1>
        <p className="muted">Check the link you were sent.</p>
      </section>
    </Chrome>
  );
}
