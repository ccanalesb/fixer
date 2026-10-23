import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Card } from './Card';

function readStored(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'open';
  } catch {
    return false;
  }
}

const linkedTo = (id: string | undefined) => id !== undefined && window.location.hash === `#${id}`;

/**
 * Card that folds to its title and a one-line summary; starts folded and remembers the last state.
 * With an `id`, a link to `#id` opens it and scrolls to it.
 */
export function FoldingCard({
  id,
  title,
  summary,
  storageKey,
  children,
}: {
  id?: string;
  title: string;
  summary: ReactNode;
  storageKey: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => linkedTo(id) || readStored(storageKey));
  const bodyId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (linkedTo(id)) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [id]);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(storageKey, o ? 'closed' : 'open');
      } catch {
        // storage unavailable: still toggles for this visit
      }
      return !o;
    });
  };

  return (
    <div id={id} ref={ref}>
      <Card padding="lg">
        <button
          type="button"
          className="w-full flex items-baseline gap-3 text-left"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span
            aria-hidden
            className={`inline-block w-3 text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          <h3 className="text-card-title text-text font-bold">{title}</h3>
          <span className="text-sm text-text-secondary truncate">{summary}</span>
        </button>
        {open ? (
          <div id={bodyId} className="mt-4">
            {children}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
