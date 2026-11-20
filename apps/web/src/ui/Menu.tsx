/**
 * A button that opens a menu, on Radix's dropdown menu: Enter, Space or the arrow keys open it, the
 * arrows, Home and End move through it, typing jumps to an item, Escape closes it and returns focus
 * to the button. The menu is drawn over everything and stays inside the window, so a list's edge
 * never cuts it off.
 */
import { DropdownMenu as Radix } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';

export interface MenuItem {
  label: string;
  /** A second line, such as what the item will do. */
  hint?: string;
  icon?: ReactNode;
  /** Keys that do the same, shown at the item's end. */
  keys?: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
}

const OPEN_EVENT = 'inklog:open-menu';

/** Opens the menu of a MenuButton from elsewhere, such as a right-click on its row. */
export function openMenu(button: Element | null | undefined): void {
  button?.dispatchEvent(new Event(OPEN_EVENT));
}

export function MenuButton({
  label,
  items,
  children,
  className,
  align = 'start',
  side = 'bottom',
  header,
  title,
}: {
  /** Says what the button is for, for screen readers. */
  label: string;
  items: (MenuItem | 'divider')[];
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end' | 'center';
  side?: 'bottom' | 'right' | 'top' | 'left';
  /** Text at the top of the menu, such as who is signed in. */
  header?: ReactNode;
  /** A tooltip, when the label alone would be too long for one. */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = button.current;
    const show = () => setOpen(true);
    element?.addEventListener(OPEN_EVENT, show);
    return () => element?.removeEventListener(OPEN_EVENT, show);
  }, []);

  return (
    <Radix.Root open={open} onOpenChange={setOpen} modal={false}>
      <Radix.Trigger asChild>
        <button ref={button} type="button" aria-label={label} title={title ?? label} className={className}>
          {children}
        </button>
      </Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] min-w-48 max-w-[min(320px,calc(100vw-16px))] animate-pop overflow-y-auto rounded-2xl bg-white p-1.5 text-[13.5px] text-[#1b1826] shadow-pop outline-none"
        >
          {header && <div className="mb-1 flex flex-col border-b border-[#eceaf2] px-2.5 pt-1.5 pb-2.5 leading-snug">{header}</div>}
          {items.map((item, index) =>
            item === 'divider' ? (
              <Radix.Separator key={`divider-${index}`} className="mx-1 my-1.5 h-px bg-[#eceaf2]" />
            ) : (
              <Radix.Item
                key={item.label}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 outline-none select-none data-disabled:cursor-default data-disabled:opacity-40 data-highlighted:bg-[#f2f0f8] touch:min-h-11',
                  item.danger && 'text-removed data-highlighted:bg-removed/8',
                )}
              >
                {item.icon && <span className="grid size-4 shrink-0 place-items-center text-[#6c6980] [&_svg]:size-4">{item.icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{item.label}</span>
                  {item.hint && <span className="text-[12px] leading-snug text-[#6c6980]">{item.hint}</span>}
                </span>
                {item.keys && <kbd className="shrink-0 font-sans text-[11.5px] text-[#9390a6]">{item.keys}</kbd>}
              </Radix.Item>
            ),
          )}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
