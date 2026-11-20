/**
 * The switcher, the panel's header inside a notebook: the notebook's colour tile and name, and in
 * the cloud a searchable list of every notebook with when it was last changed, then New notebook
 * and Home. The laptop program serves one notebook, so there it is only the name.
 */
import { ChevronsUpDown, House, Plus, Search } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useId, useState } from 'react';
import { cn } from '../lib/cn';
import { navigate, notebookOf, useRoute } from '../router';
import { useApp, useShelf } from '../store';
import { Ago, WetDot } from '../ui/Marks';
import { NotebookTile } from '../ui/NotebookTile';

export function Switcher() {
  const route = useRoute();
  const id = notebookOf(route)!;
  const info = useApp((state) => state.info);
  const cards = useShelf((state) => state.cards);
  const cloud = useShelf((state) => state.host) === 'cloud';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();
  const colour = info?.colour ?? cards.find((card) => card.id === id)?.colour ?? '#7350f2';
  const name = info?.name ?? id;

  const title = (
    <>
      <NotebookTile colour={colour} size={30} />
      <span className="min-w-0 flex-1 truncate text-left text-[16px] font-semibold tracking-[-0.015em]">{name}</span>
    </>
  );
  if (!cloud) return <span className="flex min-w-0 flex-1 items-center gap-2.5 px-1">{title}</span>;

  const words = query.trim().toLowerCase();
  const notebooks = cards.filter((card) => !card.archived && (!words || card.title.toLowerCase().includes(words)));
  const choices = [
    ...notebooks.map((card) => () => navigate({ page: 'notebook', id: card.id, folder: '' })),
    () => useShelf.getState().setCreating(true),
    () => navigate('/'),
  ];
  const choose = (index: number) => {
    setOpen(false);
    choices[index]?.();
  };
  const option = 'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] aria-selected:bg-[#f2f0f8] touch:min-h-11';

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery('');
        setAt(0);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Switch notebook"
          className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1.5 outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-white/[0.08]"
        >
          {title}
          <ChevronsUpDown className="size-4 shrink-0 text-white/50" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8} collisionPadding={8} aria-label="Switch notebook" className="z-[60] w-[300px] max-w-[calc(100vw-16px)] animate-pop rounded-2xl bg-white p-1.5 text-[#1b1826] shadow-pop outline-none">
          <label className="mb-1 flex h-10 items-center gap-2 border-b border-[#eceaf2] px-2.5 text-[#6c6980]">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              type="search"
              autoFocus
              value={query}
              placeholder="Find a notebook…"
              aria-label="Find a notebook"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={`${listId}-${at}`}
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-[#1b1826] outline-none placeholder:text-[#9390a6] touch:text-[16px]"
              onChange={(event) => {
                setQuery(event.target.value);
                setAt(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') setAt((at + 1) % choices.length);
                else if (event.key === 'ArrowUp') setAt((at - 1 + choices.length) % choices.length);
                else if (event.key === 'Enter') choose(at);
                else return;
                event.preventDefault();
              }}
            />
          </label>
          <ul id={listId} role="listbox" aria-label="Notebooks" className="scroll-quiet max-h-[min(50vh,360px)] overflow-y-auto">
            {notebooks.map((card, index) => (
              <li key={card.id} id={`${listId}-${index}`} role="option" aria-selected={index === at} aria-current={card.id === id ? 'true' : undefined} className={option} onPointerMove={() => setAt(index)} onClick={() => choose(index)}>
                <NotebookTile colour={card.colour} size={24} />
                <span className={cn('min-w-0 flex-1 truncate', card.id === id && 'font-semibold')}>{card.title}</span>
                {card.summary?.uncommitted ? <WetDot count={card.summary.uncommitted} /> : null}
                <span className="shrink-0 text-[12px] text-[#9390a6]">{card.summary?.last ? <Ago at={card.summary.last.at} /> : null}</span>
              </li>
            ))}
            {!notebooks.length && <li className="px-2.5 py-2 text-[13px] text-[#6c6980]">No notebook matches.</li>}
            <li role="separator" className="mx-1 my-1.5 h-px bg-[#eceaf2]" />
            <li id={`${listId}-${notebooks.length}`} role="option" aria-selected={at === notebooks.length} className={option} onPointerMove={() => setAt(notebooks.length)} onClick={() => choose(notebooks.length)}>
              <span className="grid size-6 place-items-center rounded-lg bg-brand-soft text-brand">
                <Plus className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
              </span>
              <span className="font-medium">New notebook</span>
            </li>
            <li id={`${listId}-${notebooks.length + 1}`} role="option" aria-selected={at === notebooks.length + 1} className={option} onPointerMove={() => setAt(notebooks.length + 1)} onClick={() => choose(notebooks.length + 1)}>
              <span className="grid size-6 place-items-center rounded-lg bg-[#efeef5] text-[#6c6980]">
                <House className="size-3.5" aria-hidden="true" />
              </span>
              <span className="font-medium">Home</span>
            </li>
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
