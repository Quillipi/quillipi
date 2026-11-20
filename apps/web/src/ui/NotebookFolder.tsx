/**
 * A notebook as a folder, drawn like the folders in Cloud Dock's Shared Folders: a tab on the left,
 * the back's edge showing behind it in violet, and the notebook's tile, name and facts on the
 * front. The first folder on Home is the deep violet one; the rest are white.
 *
 * The idea kept from the glass-folder component the design started from is what happens on hover: the
 * sheets inside rise out of the pocket on a spring, and each sheet carries the name of a section
 * edited lately, so you see what is in the notebook before opening it.
 *
 * The shape is three plain rounded boxes and one small inverse corner, with no clip-path and no
 * backdrop filter, so every corner is round in every browser and at every width. The whole folder
 * is one link: a click opens the notebook.
 */
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/cn';

const SPRING = { type: 'spring', stiffness: 380, damping: 26 } as const;

export function NotebookFolder({
  href,
  onClick,
  tone = 'light',
  icon,
  title,
  meta,
  sheets = [],
  marks,
  people,
  menu,
  className,
}: {
  href?: string;
  onClick?(event: React.MouseEvent<HTMLAnchorElement>): void;
  /** `deep` is the violet folder, for the notebook changed last; `add` is the dashed one for New notebook. */
  tone?: 'light' | 'deep' | 'add';
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  /** Names of sections edited lately, newest first: the sheets that rise on hover. */
  sheets?: string[];
  /** Bottom left: what state it is in. Bottom right: who worked in it. */
  marks?: ReactNode;
  people?: ReactNode;
  /** The ··· button, placed at the front's top right. */
  menu?: ReactNode;
  className?: string;
}) {
  const [lifted, setLifted] = useState(false);
  const still = useReducedMotion();
  const deep = tone === 'deep';
  const add = tone === 'add';
  const front = deep ? '#221a3d' : '#ffffff';
  const paper = sheets.slice(0, 2);

  return (
    <div
      className={cn('group/folder relative h-[178px] transition-transform duration-200 ease-out hover:-translate-y-0.5', className)}
      onPointerEnter={() => setLifted(true)}
      onPointerLeave={() => setLifted(false)}
      onFocus={() => setLifted(true)}
      onBlur={() => setLifted(false)}
    >
      {/* The back of the folder, showing above the front to the right of the tab. */}
      {!add && <div className={cn('absolute top-[9px] right-0 left-[34%] h-20 rounded-[18px] bg-linear-to-b', deep ? 'from-[#9d86ff] to-[#7350f2]' : 'from-[#d9cffd] to-[#c3b3fb]')} aria-hidden="true" />}

      {/* The sheets in the pocket: the sections edited lately. */}
      {paper.map((name, index) => (
        <motion.div
          key={name}
          aria-hidden="true"
          initial={false}
          animate={still ? {} : { y: lifted ? -15 - index * 9 : 0, rotate: lifted ? (index ? 2.2 : -1.6) : 0 }}
          transition={{ ...SPRING, delay: lifted ? index * 0.04 : 0 }}
          className={cn(
            'absolute top-[20px] h-16 rounded-[10px] bg-white px-2.5 pt-1.5 shadow-[0_1px_2px_rgb(27_24_38/10%),0_0_0_1px_rgb(27_24_38/5%)]',
            index ? 'right-[9%] left-[46%]' : 'right-[5%] left-[40%]',
          )}
          style={{ zIndex: 2 - index }}
        >
          <span className="block truncate text-[10.5px] leading-tight font-medium text-[#6c6980]">{name}</span>
          <span className="mt-1 block h-1 w-4/5 rounded-full bg-[#eceaf2]" />
        </motion.div>
      ))}

      {/* The front: the tab, the inverse corner that joins it to the body, and the body. The shadow follows all three. */}
      <div
        className="pointer-events-none absolute inset-0 z-[3]"
        style={add ? undefined : { filter: `${deep ? 'drop-shadow(0 14px 22px rgb(40 24 110 / 38%))' : 'drop-shadow(0 10px 18px rgb(27 24 38 / 10%))'} drop-shadow(0 0 1px rgb(27 24 38 / 16%))` }}
        aria-hidden="true"
      >
        {add ? (
          <div className="absolute inset-x-0 top-[26px] bottom-0 rounded-[20px] border border-dashed border-brand/40 bg-background/80" />
        ) : (
          <>
            <div className="absolute top-0 left-0 h-[42px] w-[40%] rounded-t-[18px]" style={{ background: front }} />
            <div className="absolute top-[10px] left-[40%] size-4" style={{ background: `radial-gradient(circle at 100% 0, transparent 15.5px, ${front} 16px)` }} />
            <div className="absolute inset-x-0 top-[26px] bottom-0 rounded-[20px] rounded-tl-none" style={{ background: deep ? 'linear-gradient(180deg, #221a3d, #1a1430)' : front }} />
          </>
        )}
      </div>

      <a
        href={href}
        onClick={onClick}
        className={cn(
          'absolute inset-0 z-[4] flex flex-col rounded-[20px] px-4 pt-3 pb-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          deep ? 'text-white' : 'text-foreground',
          add && 'items-center justify-center pt-[26px] text-center',
        )}
      >
        {icon}
        <span className={cn('mt-auto block truncate text-[15px] font-semibold tracking-[-0.01em]', add && 'mt-2.5 text-brand')}>{title}</span>
        <span className={cn('mt-0.5 block truncate text-[12.5px]', deep ? 'text-white/60' : 'text-muted-foreground')}>{meta}</span>
        {(marks || people) && (
          <span className="mt-2.5 flex h-6 items-center gap-1.5">
            <span className="flex min-w-0 flex-1 items-center gap-1.5">{marks}</span>
            <span className="flex shrink-0 -space-x-1.5">{people}</span>
          </span>
        )}
      </a>
      {menu && <div className="absolute top-[34px] right-2.5 z-[5]">{menu}</div>}
    </div>
  );
}
