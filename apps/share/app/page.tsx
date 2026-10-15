import { Chrome } from './chrome';

export default function Home() {
  return (
    <Chrome>
      <section className="share-card">
        <h1>Files shared from harbor0</h1>
        <p className="muted">
          harbor0content.online serves the public links people make in harbor0. Open the link you
          were sent to see what was shared with you.
        </p>
        <p className="muted">
          To report a link that shares something harmful or illegal, email{' '}
          <a href="mailto:contact@harbor0.com?subject=Report%20a%20public%20link">
            contact@harbor0.com
          </a>{' '}
          with the link.
        </p>
      </section>
    </Chrome>
  );
}
