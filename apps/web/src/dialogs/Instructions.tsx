/**
 * The AI instructions editor (step 3.4c): what every AI is told before it reads or writes. There
 * are two levels. "For this notebook" is kept in the notebook's AGENTS.md and committed like any
 * other change; it opens from the overview. "For every notebook" is kept by the cloud's library;
 * it opens from Agents. An AI gets both at the top of every `map` reply, those for every notebook
 * first.
 *
 * Only this screen changes them. No Quillipi tool can, so an AI can never rewrite its own rules,
 * and text hidden in a page can't make it do so.
 *
 * The editor is a plain text box, with headings and rules to add in one press, how many tokens the
 * instructions cost in every chat (with a warning when they get long), and a preview of exactly
 * what an AI receives.
 */
import { MAX_INSTRUCTIONS, estimateTokens, renderInstructions } from '@inklog/core';
import { Eye, PencilLine, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { cn } from '../lib/cn';
import { useApp, useShelf } from '../store';
import { Button } from '../ui/Button';
import { Dialog, DialogActions } from '../ui/Dialog';

const HEADINGS = ['Before you start', 'When reading', 'When writing', 'When committing', 'Never'];
const RULES = [
  'Write completely and correctly.',
  'Say what you didn’t check.',
  'Don’t guess: ask when you are unsure.',
  'Record every decision with what, why and how.',
  'Write simply, in plain words.',
  'Commit with a message that says what changed and why.',
  'After a change, update every other place that states the same fact.',
];
/** Past this the instructions cost enough in every chat to be worth trimming. */
const LONG = 600;

export function Instructions({ scope, onClose }: { scope: 'notebook' | 'shared'; onClose(): void }) {
  const info = useApp((state) => state.info);
  const me = useShelf((state) => state.me);
  const cloud = useShelf((state) => state.host) === 'cloud';
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState<string>();
  const [saved, setSaved] = useState('');
  /** The other level's text, for the preview: an AI gets both. */
  const [other, setOther] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    const load = async () => {
      if (scope === 'notebook') {
        const mine = await api.instructions();
        const shared = cloud ? (await api.sharedInstructions().catch(() => ({ text: '' }))).text : '';
        return { mine: mine.text, other: shared };
      }
      return { mine: (await api.sharedInstructions()).text, other: '' };
    };
    load().then(
      (loaded) => {
        if (!current) return;
        setText(loaded.mine);
        setSaved(loaded.mine);
        setOther(loaded.other);
      },
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [scope, cloud]);

  const value = text ?? '';
  const tokens = estimateTokens(value);
  const owner = info?.person.name ?? me?.name ?? 'the owner';
  const given = renderInstructions(scope === 'notebook' ? { owner, shared: other, notebook: value } : { owner, shared: value, notebook: 'This notebook’s own instructions come here.' });
  const dirty = text !== undefined && value.trim() !== saved.trim();
  const tooLong = value.length > MAX_INSTRUCTIONS;

  const add = (line: string) => {
    setText(`${value.trimEnd()}${value.trim() ? '\n' : ''}${line}\n`);
    requestAnimationFrame(() => {
      const area = box.current;
      if (!area) return;
      area.focus();
      area.selectionStart = area.selectionEnd = area.value.length;
      area.scrollTop = area.scrollHeight;
    });
  };
  const save = async () => {
    setBusy(true);
    try {
      await (scope === 'notebook' ? api.setInstructions(value) : api.setSharedInstructions(value));
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={scope === 'notebook' ? `AI instructions for ${info?.name ?? 'this notebook'}` : 'AI instructions for every notebook'}
      description={
        scope === 'notebook'
          ? 'What this notebook is and how to work in it. Every AI gets them before it reads or writes here.'
          : 'Your way of working. Every AI gets them in every notebook, before the notebook’s own.'
      }
      onClose={onClose}
      className="w-[min(760px,calc(100vw-32px))]"
    >
      <div className="mb-3 flex items-center gap-2">
        <div role="tablist" aria-label="Instructions" className="flex gap-0.5 rounded-[10px] bg-secondary p-0.5">
          {(
            [
              ['write', 'Write', PencilLine],
              ['preview', 'What an AI receives', Eye],
            ] as const
          ).map(([key, label, Shape]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-tile touch:h-9"
            >
              <Shape className="size-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className={cn('flex items-center gap-1 text-[12.5px] text-muted-foreground tabular-nums', tokens > LONG && 'font-medium text-[#b45309]')} title="Added to every chat that uses this notebook">
          {tokens > LONG && <TriangleAlert className="size-3.5" aria-hidden="true" />}
          about {tokens.toLocaleString()} tokens in every chat
        </span>
      </div>

      {tab === 'write' ? (
        <>
          <textarea
            ref={box}
            value={value}
            disabled={text === undefined}
            spellCheck
            rows={12}
            aria-label="Instructions"
            placeholder={text === undefined ? 'Opening…' : 'Before you start\n- Read Start here first.\n\nWhen writing\n- Write completely and correctly.'}
            onChange={(event) => setText(event.target.value)}
            className="scroll-quiet block h-[min(40vh,340px)] w-full resize-none rounded-xl border border-input bg-background px-3.5 py-3 font-mono text-[13px] leading-relaxed outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-brand focus:ring-[3px] focus:ring-brand/15 touch:text-[16px]"
          />
          <Suggestions label="Add a heading" items={HEADINGS.filter((heading) => !value.includes(heading))} onAdd={(heading) => add(`${value.trim() ? '\n' : ''}${heading}`)} />
          <Suggestions label="Add a rule" items={RULES.filter((rule) => !value.includes(rule))} onAdd={(rule) => add(`- ${rule}`)} />
        </>
      ) : (
        <pre className="scroll-quiet h-[min(52vh,460px)] overflow-auto rounded-xl border border-border bg-surface px-3.5 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
          {given || 'Nothing: there are no instructions yet, so an AI gets only the notebook’s map.'}
        </pre>
      )}

      {tokens > LONG && !tooLong && <p className="mt-3 text-[12.5px] leading-snug text-[#b45309]">These are long. An AI reads them at the start of every chat, so each line costs every time: keep the rules that change what it does.</p>}
      {tooLong && (
        <p className="mt-3 text-[12.5px] text-removed" role="alert">
          Too long by {(value.length - MAX_INSTRUCTIONS).toLocaleString()} characters. Quillipi keeps at most {MAX_INSTRUCTIONS.toLocaleString()}.
        </p>
      )}
      {error && (
        <p className="mt-3 text-[13px] text-removed" role="alert">
          {error}
        </p>
      )}

      <DialogActions className="justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
        <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-added" aria-hidden="true" />
          <span>
            Only you change these, here. No AI tool can.
            {scope === 'notebook' && ' Saving makes an uncommitted change, to commit like any other.'}
          </span>
        </p>
        <span className="flex shrink-0 justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dirty || busy || tooLong} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </span>
      </DialogActions>
    </Dialog>
  );
}

function Suggestions({ label, items, onAdd }: { label: string; items: string[]; onAdd(item: string): void }) {
  if (!items.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[12px] font-medium text-muted-foreground">{label}</span>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onAdd(item)}
          className="flex h-7 items-center gap-1 rounded-full border border-border bg-background pr-2.5 pl-1.5 text-[12.5px] outline-none transition-colors hover:border-brand-tint hover:bg-brand-soft hover:text-brand focus-visible:ring-2 focus-visible:ring-ring touch:h-9"
        >
          <Plus className="size-3 opacity-60" aria-hidden="true" />
          {item}
        </button>
      ))}
    </div>
  );
}
