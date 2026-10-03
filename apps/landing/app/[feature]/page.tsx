import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';
import { features } from '../features';
import { Shot } from '../shot';
import { SignupButton, SiteFoot, SiteNav } from '../site-chrome';

type Props = { params: Promise<{ feature: string }> };

// One static page per feature; any other address is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  return features.map(({ id }) => ({ feature: id }));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { feature: id } = await params;
  const found = features.find((entry) => entry.id === id);
  return found ? { title: `${found.name} — harbor0`, description: found.lede } : {};
}

export default async function FeaturePage({ params }: Props) {
  const { feature: id } = await params;
  const feature = features.find((entry) => entry.id === id);
  if (!feature) notFound();
  const others = features.filter((entry) => entry !== feature);
  return (
    <main className="landing learn" style={{ '--tint': feature.tint } as CSSProperties}>
      <SiteNav />

      <section className="wrap learn-hero">
        <Link href="/#product" className="label">
          <ArrowLeft size={14} />
          Product — {feature.name}
        </Link>
        <h1>{feature.tagline}</h1>
        <div className="hero-foot">
          <p className="lede">{feature.lede}</p>
          <SignupButton />
        </div>
        <ul className="platforms" aria-label="Available on">
          {feature.platforms.map((platform) => (
            <li key={platform}>{platform}</li>
          ))}
          <li>
            <Link href="/apps">Get the apps</Link>
          </li>
        </ul>
        <Shot picture={feature} tint={feature.tint} flat />
      </section>

      <section className="wrap section">
        <p className="label">01 — How it works</p>
        <ol className="steps">
          {feature.steps.map(([title, text], index) => (
            <li key={title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="wrap section">
        <p className="label">02 — A closer look</p>
        <div className="learn-split">
          <div>
            <h2>{feature.more.title}</h2>
            <p>{feature.more.text}</p>
          </div>
          <Shot picture={feature.more} tint={feature.tint} flat />
        </div>
      </section>

      <section className="wrap section">
        <p className="label">03 — Good to know</p>
        <dl className="details">
          {feature.facts.map(([name, text], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section">
        <p className="label">04 — Questions</p>
        <div className="faq">
          {feature.questions.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="wrap section">
        <p className="label">05 — More of harbor0</p>
        <div className="others">
          {others.map((other) => (
            <Link
              key={other.id}
              href={`/${other.id}`}
              style={{ '--tint': other.tint } as CSSProperties}
            >
              <strong>{other.name}</strong>
              <span>{other.text}</span>
              <ArrowRight size={18} />
            </Link>
          ))}
        </div>
      </section>

      <section className="wrap section learn-cta">
        <h2>50 GB free for beta members. Nothing to pay during the beta.</h2>
        <SignupButton />
      </section>

      <SiteFoot />
    </main>
  );
}
