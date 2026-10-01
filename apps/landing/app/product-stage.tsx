import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { features } from './features';
import { Shot } from './shot';

/** The product tour: one row per feature, each with a tilted, annotated screenshot. */
export function ProductStage() {
  return (
    <div className="features">
      {features.map((feature, index) => (
        <article
          key={feature.id}
          className="feature"
          style={{ '--tint': feature.tint } as CSSProperties}
        >
          <div className="feature-text">
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h3>{feature.name}</h3>
            <p>{feature.text}</p>
            <Link
              href={`/${feature.id}`}
              className="text-link"
              aria-label={`Learn more about ${feature.name}`}
            >
              Learn more
              <ArrowRight size={16} />
            </Link>
          </div>
          <Shot picture={feature} tint={feature.tint} notes={feature.notes} />
        </article>
      ))}
    </div>
  );
}
