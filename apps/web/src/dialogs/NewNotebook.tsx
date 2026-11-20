/**
 * New notebook: a title, what it is for (optional) and a colour, picked for you and changeable.
 * Beside them, its folder as Home will show it, with the title as you type and the colour's
 * tile; the permanent ID shows under the title, with -2 when the ID is taken, as the library will
 * make it. Create opens the new notebook's overview at once, ready to write in; its GitHub repo is
 * made in the background.
 *
 * Or a notebook whose repo is already in the notebooks' GitHub organization can be added.
 */
import { MAX_ABOUT, MAX_NOTEBOOK_TITLE, NOTEBOOK_COLOURS, colourFor, notebookId, notebookTitle } from '@inklog/core';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { useShelf } from '../store';
import { Button } from '../ui/Button';
import { Dialog, DialogActions, Field, inputStyles } from '../ui/Dialog';
import { NotebookFolder } from '../ui/NotebookFolder';
import { NotebookTile } from '../ui/NotebookTile';

export function NewNotebook({ onClose }: { onClose(): void }) {
  const cards = useShelf((state) => state.cards);
  const github = useShelf((state) => state.me?.github);
  const [mode, setMode] = useState<'new' | 'github'>('new');
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [chosen, setChosen] = useState<string>();
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const taken = new Set(cards.map((card) => card.id));
  const id = notebookTitle(title) ? notebookId(title, (candidate) => taken.has(candidate)) : '';
  const colour = chosen ?? colourFor(id || 'notebook');

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const card = mode === 'new' ? await api.createNotebook({ title: notebookTitle(title), ...(about.trim() ? { about } : {}), colour }) : await api.addNotebook(repo.trim());
      useShelf.getState().putCard(card);
      onClose();
      navigate({ page: 'notebook', id: card.id, folder: '' });
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  const plain = notebookId(title, () => false);
  return (
    <Dialog
      title={mode === 'new' ? 'New notebook' : 'Add a notebook from GitHub'}
      description={mode === 'new' ? 'Ready to write in at once. Its private GitHub repo is made in the background.' : undefined}
      onClose={onClose}
      className={mode === 'new' ? 'w-[min(680px,calc(100vw-32px))]' : undefined}
    >
      <form onSubmit={(event) => void create(event)}>
        {mode === 'new' ? (
          <div className="grid grid-cols-[minmax(0,1fr)_212px] items-start gap-7 max-sm:grid-cols-1">
            <div className="flex flex-col gap-4">
              <div>
                <Field label="Title">
                  <input autoFocus required value={title} maxLength={MAX_NOTEBOOK_TITLE} placeholder="Such as Gym rollup" onChange={(event) => setTitle(event.target.value)} className={inputStyles} />
                </Field>
                <p className="mt-1.5 min-h-[34px] text-[12px] leading-snug text-muted-foreground" aria-live="polite">
                  {id ? (
                    <>
                      <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">{id}</code>{' '}
                      {id !== plain ? `${plain} is taken, so it gets this one: its address and GitHub repo name, which never changes.` : 'Its address and GitHub repo name; it never changes.'}
                    </>
                  ) : (
                    'Its ID, made from the title, will show here.'
                  )}
                </p>
              </div>
              <Field label="What is it for?" hint="Optional">
                <input value={about} maxLength={MAX_ABOUT} placeholder="One line" onChange={(event) => setAbout(event.target.value)} className={inputStyles} />
              </Field>
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">Colour</legend>
                <div className="flex flex-wrap gap-2">
                  {NOTEBOOK_COLOURS.map((option) => (
                    <label key={option} title={option} className="relative grid size-8 cursor-pointer place-items-center rounded-full ring-offset-2 transition-transform hover:scale-110 has-checked:ring-2 has-checked:ring-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring touch:size-10" style={{ background: option }}>
                      <input type="radio" name="colour" value={option} checked={colour === option} onChange={() => setChosen(option)} aria-label={`Colour ${option}`} className="peer sr-only" />
                      <Check className="size-4 text-white opacity-0 peer-checked:opacity-100" strokeWidth={3} aria-hidden="true" />
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="rounded-2xl bg-surface p-4 pt-5 ring-1 ring-border max-sm:hidden" aria-hidden="true">
              <NotebookFolder tone="deep" icon={<NotebookTile colour={colour} size={38} />} title={notebookTitle(title) || 'New notebook'} meta={about.trim() || 'As Home will show it'} sheets={['Start here', 'About']} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label={`Repo in ${github}`}>
              <input autoFocus required value={repo} placeholder="Such as gym-rollup" onChange={(event) => setRepo(event.target.value)} className={inputStyles} />
            </Field>
            <p className="text-[13px] leading-relaxed text-muted-foreground">Its history is copied in from GitHub, with the same commit IDs, the first time you or Claude open it. The GitHub App must be able to reach the repo.</p>
          </div>
        )}
        {error && (
          <p className="mt-3 text-[13px] text-removed" role="alert">
            {error}
          </p>
        )}
        <DialogActions className="justify-between max-sm:flex-col-reverse max-sm:items-stretch">
          <Button variant="link" onClick={() => setMode(mode === 'new' ? 'github' : 'new')}>
            {mode === 'new' ? 'Add one already on GitHub' : 'Make a new one instead'}
          </Button>
          <span className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || (mode === 'new' ? !id : !repo.trim())}>
              {busy ? (mode === 'new' ? 'Making…' : 'Adding…') : mode === 'new' ? 'Create notebook' : 'Add'}
            </Button>
          </span>
        </DialogActions>
      </form>
    </Dialog>
  );
}
