import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import { SiteFoot, SiteNav } from './site-chrome';

export const contact = 'contact@harbor0.com';
export const mail = <a href={`mailto:${contact}`}>{contact}</a>;

/** A heading and its paragraphs; a `<ul>` is rendered as a list instead of a paragraph. */
export type LegalSection = [string, ReactNode[]];

export function LegalPage({
  title,
  updated,
  sections,
}: {
  title: string;
  updated: string;
  sections: LegalSection[];
}) {
  return (
    <main className="landing learn" style={{ '--tint': 'var(--primary)' } as CSSProperties}>
      <SiteNav />

      <section className="wrap learn-hero">
        <p className="label">Legal</p>
        <h1>{title}</h1>
        <p className="lede">Last updated {updated}.</p>
      </section>

      <article className="wrap legal">
        {sections.map(([heading, body], i) => (
          <section key={heading} id={heading.toLowerCase().replace(/[^a-z]+/g, '-')}>
            <h2>
              <span>{String(i + 1).padStart(2, '0')}</span>
              {heading}
            </h2>
            {body.map((part, j) =>
              isValidElement(part) && part.type === 'ul' ? part : <p key={j}>{part}</p>,
            )}
          </section>
        ))}
      </article>

      <SiteFoot />
    </main>
  );
}
