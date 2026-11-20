/**
 * The 21st.dev component `animated-file-tree` by arunachalam, which the design chose,
 * with its own markup and Tailwind classes, so it looks and moves as its demo does: 32 px rows,
 * the curved branch lines, the accent line that springs to the row you are on, and the hover pill
 * that glides between rows. It reads its colours from the theme's tokens (foreground,
 * muted-foreground, accent, border, ring), which the panel sets for its dark ground.
 *
 * Quillipi's additions, each marked "Quillipi:":
 *
 * - `motion/react` (framer-motion's new name) instead of `framer-motion`.
 * - Keyboard, following the WAI-ARIA tree pattern: one Tab stop for the whole tree; Up, Down, Home
 *   and End move between visible rows; Right opens a folder or goes into it, Left closes it or goes
 *   to its folder; typing a letter jumps to the next row starting with it. The original made every
 *   row its own Tab stop and let rows inside a closed folder take focus while invisible.
 * - A closed folder's rows are `inert`, so they can't be focused or found.
 * - TreeFolder can be controlled (`expanded`, `onExpandedChange`), so a folder opens by itself
 *   when the section you are in is inside it, and the open folders are remembered.
 * - Rows take `end` (marks beside the label) and `actions` (a ··· menu button that sits beside the
 *   row, not inside it, since a button can't hold a button), and `rowProps` for the row's button
 *   (drag and drop, the context menu).
 * - TreeBranch: a row with rows of its own (a section and its headings), so the accent line runs on
 *   down to the heading you are reading.
 * - The lines meet each row at its middle, measured, so they stay right on a touch screen's taller rows.
 * - Motion follows the system's reduced-motion setting (MotionConfig).
 * - TreeViewProps leaves out the DOM's own `onSelect`, whose type clashes with the tree's.
 */
import { LayoutGroup, MotionConfig, motion } from 'motion/react';
import {
  Children,
  type ButtonHTMLAttributes,
  type ComponentType,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export type TreeVariant = 'line' | 'pill';

type IconType = LucideIcon | ComponentType<{ className?: string }>;

interface TreeContextValue {
  selectedId: string | null;
  hoveredId: string | null;
  variant: TreeVariant;
  activeColor: string;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTreeContext() {
  const context = useContext(TreeContext);
  if (!context) throw new Error('Tree components must be rendered within a TreeView.');
  return context;
}

function isChildActive(child: ReactNode, activeId: string | null): boolean {
  if (!activeId || !isValidElement(child)) return false;
  const props = child.props as { id?: string; children?: ReactNode };
  if (props.id === activeId) return true;
  if (props.children) return Children.toArray(props.children).some((nestedChild) => isChildActive(nestedChild, activeId));
  return false;
}

interface TreeSvgLinesProps {
  offsets: number[];
  selectedOffset: number | null;
  variant: TreeVariant;
  activeColor: string;
  className?: string;
}

export function TreeSvgLines({ offsets, selectedOffset, variant, activeColor, className }: TreeSvgLinesProps) {
  if (offsets.length === 0) return null;
  const lastOffset = offsets[offsets.length - 1]!;
  const totalHeight = lastOffset + 1;
  const lastV = lastOffset - 5;

  return (
    <svg aria-hidden="true" width="12" height={totalHeight} viewBox={`0 0 12 ${totalHeight}`} fill="none" className={cn('pointer-events-none absolute top-0 left-[12.5px] z-10 text-border select-none', className)}>
      <path d={`M0.5 0 V${lastV}`} stroke="currentColor" strokeWidth="1" />
      {offsets.map((y, index) => {
        const v = y - 5;
        return <path key={index} d={`M0.5 ${v} Q0.5 ${y} 5.5 ${y} H11.5`} stroke="currentColor" strokeWidth="1" />;
      })}
      {variant === 'line' && selectedOffset !== null && (
        <motion.path
          d={`M0.5 0 V${selectedOffset - 5} Q0.5 ${selectedOffset} 5.5 ${selectedOffset} H11.5`}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={activeColor}
          initial={false}
          animate={{ d: `M0.5 0 V${selectedOffset - 5} Q0.5 ${selectedOffset} 5.5 ${selectedOffset} H11.5` }}
          transition={{ type: 'spring', stiffness: 450, damping: 35 }}
        />
      )}
    </svg>
  );
}

export interface TreeListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function TreeList({ children, className, ...props }: TreeListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [offsets, setOffsets] = useState<number[]>([]);
  const { selectedId, variant, activeColor } = useTreeContext();
  const childrenCount = Children.count(children);

  const activeIndex = useMemo(() => {
    if (!selectedId) return -1;
    const childArray = Children.toArray(children).filter(isValidElement);
    return childArray.findIndex((child) => isChildActive(child, selectedId));
  }, [children, selectedId]);

  const selectedOffset = activeIndex >= 0 && activeIndex < offsets.length ? offsets[activeIndex]! : null;

  const updateOffsets = useCallback(() => {
    if (!containerRef.current) return;
    const directChildren = Array.from(containerRef.current.children).filter((el) => el.tagName.toLowerCase() !== 'svg') as HTMLElement[];
    // Quillipi: the middle of the child's first row, which is 16 px for the original's 32 px rows and stays right on a phone's 44 px rows.
    const newOffsets = directChildren.map((child) => child.offsetTop + (child.querySelector<HTMLElement>('[role=treeitem]')?.offsetHeight ?? 32) / 2);
    // Quillipi: only a real change re-renders, since this runs after every render of the tree.
    setOffsets((before) => (before.length === newOffsets.length && before.every((y, i) => y === newOffsets[i]) ? before : newOffsets));
  }, []);

  useLayoutEffect(() => {
    updateOffsets();
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(() => updateOffsets());
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [childrenCount, updateOffsets]);

  return (
    <div ref={containerRef} role="group" className={cn('relative flex flex-col gap-0.5', className)} {...props}>
      <TreeSvgLines offsets={offsets} selectedOffset={selectedOffset} variant={variant} activeColor={activeColor} />
      {children}
    </div>
  );
}

/** The hover pill, shared by every row so it glides from one to the next. */
function HoverPill() {
  return <motion.div layoutId="tree-hover-pill" className="pointer-events-none absolute inset-0 z-0 rounded-md bg-accent/60" transition={{ type: 'spring', stiffness: 500, damping: 35 }} />;
}

export interface TreeItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  id: string;
  label: string;
  icon?: IconType;
  badge?: string;
  disabled?: boolean;
  /** Quillipi: marks beside the label, such as • and ✦. */
  end?: ReactNode;
  /** Quillipi: a ··· menu button, beside the row. */
  actions?: ReactNode;
}

export const TreeItem = forwardRef<HTMLButtonElement, TreeItemProps>(({ id, label, icon: Icon, badge, disabled, end, actions, className, onClick, ...props }, ref) => {
  const { selectedId, hoveredId, variant, activeColor, onSelect, onHover } = useTreeContext();
  const isSelected = selectedId === id;
  const isHovered = hoveredId === id;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onSelect(id);
    onClick?.(event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!disabled) {
        onSelect(id);
        // Quillipi: Enter does what a click does, such as opening the section.
        onClick?.(event as unknown as MouseEvent<HTMLButtonElement>);
      }
    }
  };

  return (
    <div data-tree-row className="group/row relative" onMouseEnter={() => !disabled && onHover(id)}>
      <button
        ref={ref}
        type="button"
        role="treeitem"
        aria-selected={isSelected}
        aria-disabled={disabled}
        disabled={disabled}
        data-tree-id={id}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          'group relative flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 pl-8 text-left text-sm outline-none transition-colors select-none touch:h-11',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isSelected ? (variant === 'line' ? 'font-semibold text-foreground' : 'font-medium text-foreground') : 'font-normal text-muted-foreground',
          disabled && 'pointer-events-none cursor-not-allowed opacity-40',
          className,
        )}
        {...props}
      >
        {variant === 'pill' && isSelected && <motion.div layoutId="tree-selected-pill" className="pointer-events-none absolute inset-0 z-0 rounded-md bg-secondary" transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
        {isHovered && (variant === 'line' || !isSelected) && <HoverPill />}
        <div className="relative z-10 flex min-w-0 items-center gap-2">
          {Icon && <Icon className={cn('size-4 shrink-0 transition-colors duration-150', isSelected ? (variant === 'line' ? activeColor : 'text-foreground') : 'text-muted-foreground group-hover:text-foreground')} />}
          <span className="truncate leading-none transition-colors duration-150 group-hover:text-foreground">{label}</span>
          {end}
        </div>
        {badge && <span className="relative z-10 ml-auto shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-bold tracking-tight text-muted-foreground uppercase">{badge}</span>}
      </button>
      {actions}
    </div>
  );
});

TreeItem.displayName = 'TreeItem';

export interface TreeFolderProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  label: string;
  icon?: IconType;
  badge?: string;
  defaultExpanded?: boolean;
  /** Quillipi: controlled, so a folder can open by itself and be remembered. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  end?: ReactNode;
  actions?: ReactNode;
  rowProps?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
}

export function TreeFolder({
  id,
  label,
  icon: CustomIcon,
  badge,
  defaultExpanded = false,
  expanded,
  onExpandedChange,
  children,
  disabled,
  end,
  actions,
  rowProps,
  className,
  ...props
}: TreeFolderProps) {
  const [ownExpanded, setOwnExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? ownExpanded;
  const setIsExpanded = (next: boolean) => {
    if (expanded === undefined) setOwnExpanded(next);
    onExpandedChange?.(next);
  };
  const { hoveredId, onHover } = useTreeContext();
  const contentId = useId();
  const isHovered = hoveredId === id;
  const Icon = CustomIcon || (isExpanded ? FolderOpen : Folder);

  const handleToggle = () => {
    if (!disabled) setIsExpanded(!isExpanded);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    rowProps?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    } else if (event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault();
      event.stopPropagation();
      setIsExpanded(true);
    } else if (event.key === 'ArrowLeft' && isExpanded) {
      event.preventDefault();
      event.stopPropagation();
      setIsExpanded(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-0.5', className)} {...props}>
      <div data-tree-row className="group/row relative" onMouseEnter={() => !disabled && onHover(id)}>
        <button
          type="button"
          role="treeitem"
          aria-expanded={isExpanded}
          aria-controls={contentId}
          disabled={disabled}
          data-tree-id={id}
          data-folder={isExpanded ? 'open' : 'closed'}
          className={cn('group relative flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 pl-8 text-left text-sm outline-none transition-colors select-none touch:h-11 font-normal text-muted-foreground', 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background', 'data-[drop=before]:shadow-[inset_0_2px_0_var(--ring)] data-[drop=after]:shadow-[inset_0_-2px_0_var(--ring)] data-[drop=inside]:bg-accent data-[drop=inside]:ring-1 data-[drop=inside]:ring-ring', disabled && 'pointer-events-none cursor-not-allowed opacity-40')}
          {...rowProps}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
        >
          {isHovered && <HoverPill />}
          <div className="relative z-10 flex min-w-0 items-center gap-2">
            <Icon className="size-4 shrink-0 transition-colors duration-150 text-muted-foreground group-hover:text-foreground" />
            <span className="truncate leading-none transition-colors duration-150 group-hover:text-foreground">{label}</span>
            {end}
          </div>
          <div className="relative z-10 flex items-center gap-1">
            {badge && <span className="relative z-10 ml-auto shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-bold tracking-tight text-muted-foreground uppercase">{badge}</span>}
            <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground', isExpanded && 'rotate-90')} />
          </div>
        </button>
        {actions}
      </div>
      <div id={contentId} aria-hidden={!isExpanded} inert={!isExpanded} data-tree-collapse className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-in-out pl-4', isExpanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0')}>
        <div className="overflow-hidden">
          <TreeList>{children}</TreeList>
        </div>
      </div>
    </div>
  );
}

/**
 * Quillipi: a row with rows of its own, such as a section with its headings. It is drawn like a
 * TreeItem; its rows show while `expanded`, like a folder's, so the accent line runs on down to
 * the heading you are in.
 */
export function TreeBranch({ id, label, icon: Icon, end, actions, expanded, rowProps, onPress, children }: {
  id: string;
  label: string;
  icon?: IconType;
  end?: ReactNode;
  actions?: ReactNode;
  expanded: boolean;
  rowProps?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
  onPress(): void;
  children?: ReactNode;
}) {
  const { selectedId, hoveredId, variant, activeColor, onSelect, onHover } = useTreeContext();
  const contentId = useId();
  const inside = Children.toArray(children).some((child) => isChildActive(child, selectedId));
  const isSelected = selectedId === id || inside;
  const hasRows = Children.count(children) > 0;
  const press = () => {
    onSelect(id);
    onPress();
  };
  return (
    <div className="flex flex-col gap-0.5">
      <div data-tree-row className="group/row relative" onMouseEnter={() => onHover(id)}>
        <button
          type="button"
          role="treeitem"
          aria-selected={isSelected}
          aria-expanded={hasRows ? expanded : undefined}
          aria-controls={hasRows ? contentId : undefined}
          data-tree-id={id}
          data-folder={hasRows ? (expanded ? 'open' : 'closed') : undefined}
          className={cn('group relative flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 pl-8 text-left text-sm outline-none transition-colors select-none touch:h-11', 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background', 'data-[drop=before]:shadow-[inset_0_2px_0_var(--ring)] data-[drop=after]:shadow-[inset_0_-2px_0_var(--ring)] data-[drop=inside]:bg-accent data-[drop=inside]:ring-1 data-[drop=inside]:ring-ring', isSelected ? (variant === 'line' ? 'font-semibold text-foreground' : 'font-medium text-foreground') : 'font-normal text-muted-foreground')}
          {...rowProps}
          onClick={press}
          onKeyDown={(event) => {
            rowProps?.onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              press();
            }
          }}
        >
          {hoveredId === id && <HoverPill />}
          <div className="relative z-10 flex min-w-0 items-center gap-2">
            {Icon && <Icon className={cn('size-4 shrink-0 transition-colors duration-150', isSelected ? activeColor : 'text-muted-foreground group-hover:text-foreground')} />}
            <span className="truncate leading-none transition-colors duration-150 group-hover:text-foreground">{label}</span>
            {end}
          </div>
        </button>
        {actions}
      </div>
      {hasRows && (
        <div id={contentId} aria-hidden={!expanded} inert={!expanded} data-tree-collapse className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-in-out pl-4', expanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0')}>
          <div className="overflow-hidden">
            <TreeList>{children}</TreeList>
          </div>
        </div>
      )}
    </div>
  );
}

export interface TreeSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: ReactNode;
  className?: string;
  /** Quillipi: buttons beside the title, such as New section and New folder. */
  actions?: ReactNode;
}

export function TreeSection({ title, defaultExpanded = true, children, className, actions }: TreeSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const contentId = useId();

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <div className="flex items-center gap-0.5">
        <button type="button" aria-expanded={isExpanded} aria-controls={contentId} onClick={() => setIsExpanded((prev) => !prev)} className="group flex min-w-0 flex-1 cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring touch:min-h-10">
          <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase transition-colors duration-150 group-hover:text-foreground">{title}</span>
          <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform duration-200 group-hover:text-foreground', !isExpanded && '-rotate-90')} />
        </button>
        {actions}
      </div>
      <div id={contentId} aria-hidden={!isExpanded} inert={!isExpanded} className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-in-out', isExpanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0')}>
        <div className="overflow-hidden">
          <TreeList>{children}</TreeList>
        </div>
      </div>
    </div>
  );
}

export interface TreeViewProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  selectedId?: string;
  defaultSelectedId?: string;
  variant?: TreeVariant;
  activeColor?: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
}

export function TreeView({
  selectedId: controlledSelectedId,
  defaultSelectedId,
  variant = 'line',
  activeColor = 'text-blue-600 dark:text-blue-500',
  onSelect: controlledOnSelect,
  children,
  className,
  ...props
}: TreeViewProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(defaultSelectedId || null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);
  const focused = useRef<string | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;

  const handleSelect = useCallback(
    (id: string) => {
      if (controlledSelectedId === undefined) setInternalSelectedId(id);
      controlledOnSelect?.(id);
    },
    [controlledSelectedId, controlledOnSelect],
  );

  const handleMouseLeave = useCallback(() => setHoveredId(null), []);

  // Quillipi: one Tab stop, on the row last focused, else the selected one, else the first.
  useLayoutEffect(() => {
    const rows = visibleRows(nav.current);
    const current = rows.find((row) => row.dataset.treeId === focused.current) ?? rows.find((row) => row.getAttribute('aria-selected') === 'true') ?? rows[0];
    for (const row of nav.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? []) row.tabIndex = row === current ? 0 : -1;
  });

  // Quillipi: the WAI-ARIA tree keys.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
    if (!row || event.ctrlKey || event.metaKey || event.altKey) return;
    const rows = visibleRows(nav.current);
    const at = rows.indexOf(row);
    const go = (target: HTMLElement | undefined) => {
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    if (event.key === 'ArrowDown') go(rows[at + 1]);
    else if (event.key === 'ArrowUp') go(rows[at - 1]);
    else if (event.key === 'Home') go(rows[0]);
    else if (event.key === 'End') go(rows[rows.length - 1]);
    else if (event.key === 'ArrowRight' && row.dataset.folder === 'open') go(rows[at + 1]);
    else if (event.key === 'ArrowLeft' && row.dataset.folder !== 'open') go(parentRow(row));
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase(), at: now };
      const word = typed.current.text;
      const order = [...rows.slice(at + (word.length === 1 ? 1 : 0)), ...rows.slice(0, at + (word.length === 1 ? 1 : 0))];
      go(order.find((candidate) => candidate.textContent?.trim().toLowerCase().startsWith(word)));
    }
  };

  const contextValue = useMemo(
    () => ({ selectedId, hoveredId, variant, activeColor, onSelect: handleSelect, onHover: setHoveredId }),
    [selectedId, hoveredId, variant, activeColor, handleSelect],
  );

  return (
    <TreeContext.Provider value={contextValue}>
      <MotionConfig reducedMotion="user">
      <LayoutGroup id="branching-tree-nav">
        <nav
          ref={nav}
          role="tree"
          aria-orientation="vertical"
          onMouseLeave={handleMouseLeave}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]')?.dataset.treeId;
            if (id) focused.current = id;
          }}
          className={cn('flex w-full flex-col gap-0.5 px-1 select-none', className)}
          {...props}
        >
          {children}
        </nav>
      </LayoutGroup>
      </MotionConfig>
    </TreeContext.Provider>
  );
}

/** The rows a person can see and reach, top to bottom: none inside a closed folder. */
function visibleRows(nav: HTMLElement | null): HTMLElement[] {
  return [...(nav?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])].filter((row) => !row.closest('[inert]') && !row.hasAttribute('disabled'));
}

/** The folder row a row sits under. */
function parentRow(row: HTMLElement): HTMLElement | undefined {
  const collapse = row.closest('[data-tree-collapse]');
  return collapse?.parentElement?.querySelector<HTMLElement>(':scope > [data-tree-row] > [role=treeitem]') ?? undefined;
}
