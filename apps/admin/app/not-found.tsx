import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="admin-login">
      <div className="card admin-login-card">
        <div className="admin-login-heading">
          <h1>Page not found</h1>
          <p>
            <Link href="/">Back to the console</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
