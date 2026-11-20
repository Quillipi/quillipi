/**
 * Moving a section or folder to another folder, and deleting one: the tree's ··· menu opens these.
 * A move or a delete is an uncommitted change like any other, shown in the commit list.
 */
import { Folder, House } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { useApp } from '../store';
import { type Row, moveTargets } from '../tree/model';
import { Button } from '../ui/Button';
import { Dialog, DialogActions } from '../ui/Dialog';

export function MoveDialog({ row, onClose }: { row: Row; onClose(): void }) {
  const tree = useApp((state) => state.info?.tree ?? []);
  const title = useTitle(row);
  const targets = moveTargets(tree, row);
  const [to, setTo] = useState(targets[0]?.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const move = async (event: React.FormEvent) => {
    event.preventDefault();
    if (to === undefined) return;
    setBusy(true);
    try {
      await api.organize([{ op: 'move', id: row.kind === 'section' ? row.id : `${row.path}/`, in: to }]);
      if (to) useApp.getState().setExpanded(to, true);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Move “${title}”`} description="Moving is an uncommitted change, like any other." onClose={onClose}>
      <form onSubmit={(event) => void move(event)}>
        {targets.length ? (
          <fieldset className="scroll-quiet -mx-1 flex max-h-[min(46vh,320px)] flex-col gap-0.5 overflow-y-auto px-1">
            <legend className="sr-only">Move to</legend>
            {targets.map((target) => (
              <label
                key={target.path || 'top'}
                className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg pr-2.5 text-[14px] transition-colors hover:bg-muted has-checked:bg-brand-soft has-checked:font-medium has-checked:text-brand touch:min-h-11"
                style={{ paddingLeft: `${10 + target.depth * 18}px` }}
              >
                <input type="radio" name="to" value={target.path} checked={to === target.path} onChange={() => setTo(target.path)} className="size-4 accent-brand" />
                {target.depth ? <Folder className="size-4 shrink-0 opacity-70" aria-hidden="true" /> : <House className="size-4 shrink-0 opacity-70" aria-hidden="true" />}
                <span className="truncate">{target.name}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="text-[14px] text-muted-foreground">There is no other folder to move it to. Make one with New folder.</p>
        )}
        {error && (
          <p className="mt-3 text-[13px] text-removed" role="alert">
            {error}
          </p>
        )}
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || to === undefined}>
            Move
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function DeleteDialog({ row, onClose }: { row: Row; onClose(): void }) {
  const info = useApp((state) => state.info);
  const notebook = useApp((state) => state.notebook)!;
  const title = useTitle(row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inside = row.kind === 'folder' ? (info?.sections.filter((section) => section.folder === row.path || section.folder.startsWith(`${row.path}/`)).length ?? 0) : 0;

  const remove = async () => {
    setBusy(true);
    try {
      if (row.kind === 'section') await api.deleteSection(row.id);
      else await api.deleteFolder(row.path);
      onClose();
      // Leave a page that no longer exists.
      const here = location.pathname;
      if (row.kind === 'section' && here.endsWith(`/s/${encodeURIComponent(row.id)}`)) navigate({ page: 'notebook', id: notebook, folder: '' }, { replace: true });
      if (row.kind === 'folder' && here.includes(`/f/${row.path}`)) navigate({ page: 'notebook', id: notebook, folder: '' }, { replace: true });
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={row.kind === 'section' ? `Delete “${title}”?` : `Delete the folder “${title}”?`} onClose={onClose}>
      <p className="text-[14px] leading-relaxed text-muted-foreground">
        {row.kind === 'section'
          ? 'The section leaves the notebook as an uncommitted change.'
          : inside
            ? `The folder and the ${inside === 1 ? 'section' : `${inside} sections`} in it leave the notebook as uncommitted changes.`
            : 'The empty folder leaves the notebook.'}{' '}
        Earlier commits keep every word, so nothing committed is lost.
      </p>
      {error && (
        <p className="mt-3 text-[13px] text-removed" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button onClick={onClose} autoFocus>
          Cancel
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function useTitle(row: Row): string {
  const info = useApp((state) => state.info);
  if (row.kind === 'section') return info?.sections.find((section) => section.id === row.id)?.title ?? row.id;
  const parts = row.path.split('/');
  let items = info?.tree ?? [];
  let name = row.path;
  for (const part of parts) {
    const found = items.find((item) => typeof item !== 'string' && item.folder === part);
    if (!found || typeof found === 'string') break;
    name = found.name;
    items = found.items;
  }
  return name;
}
