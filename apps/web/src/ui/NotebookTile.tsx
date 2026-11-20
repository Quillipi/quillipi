import { NotebookText } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../lib/cn';

/**
 * A notebook's tile: its colour in two shades with a notebook drawn on it, as Cloud Dock's folders
 * and rows carry their app's icon. It names the notebook wherever it appears: the switcher, Home's
 * folders and tables, the overview.
 */
export function NotebookTile({ colour, size = 32, className }: { colour: string; size?: number; className?: string }) {
  return (
    <span
      className={cn('grid shrink-0 place-items-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/28%),0_1px_2px_rgb(27_24_38/18%)]', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), background: `linear-gradient(145deg, color-mix(in srgb, ${colour} 78%, white), ${colour})` }}
      aria-hidden="true"
    >
      <NotebookText style={{ width: Math.round(size * 0.52), height: Math.round(size * 0.52) }} strokeWidth={1.9} />
    </span>
  );
}

/** Quillipi's own mark: a drop of ink. */
export function Drop({ size = 28, className }: { size?: number; className?: string }) {
  // Its own gradient per drop: one that is hidden (the rail on a phone) can't lend its paint to another.
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="8" y1="4" x2="24" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a48fff" />
          <stop offset="1" stopColor="#5b34e6" />
        </linearGradient>
      </defs>
      <path d="M16 3c5 7 9 11.5 9 16.5a9 9 0 0 1-18 0C7 14.5 11 10 16 3z" fill={`url(#${id})`} />
      <path d="M12.2 17.5c0-2 1.2-3.9 2.6-5.9" stroke="#fff" strokeOpacity=".55" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}
