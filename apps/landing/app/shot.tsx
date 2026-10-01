import type { CSSProperties } from 'react';
import type { Note, Picture } from './features';

/**
 * A screenshot on a tinted panel. By default it leans back and runs off the panel;
 * `flat` shows the whole screenshot instead.
 */
export function Shot({
  picture,
  tint,
  notes = [],
  flat,
}: {
  picture: Picture;
  tint: string;
  notes?: Note[];
  flat?: boolean;
}) {
  return (
    <figure className="shot" data-flat={flat} style={{ '--tint': tint } as CSSProperties}>
      <div className="shot-window">
        <img
          className="shot-light"
          src={picture.shot.src}
          width={picture.shot.width}
          height={picture.shot.height}
          alt={picture.alt}
        />
        <img
          className="shot-dark"
          src={picture.darkShot.src}
          width={picture.darkShot.width}
          height={picture.darkShot.height}
          alt=""
          aria-hidden="true"
        />
      </div>
      {notes.map(({ icon: Icon, title, text }) => (
        <div key={title} className="shot-note">
          <Icon size={18} />
          <span>
            <strong>{title}</strong>
            <small>{text}</small>
          </span>
        </div>
      ))}
    </figure>
  );
}
