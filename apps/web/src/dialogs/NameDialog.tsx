/**
 * Naming a new section or folder in the open notebook, or renaming a folder. A new section opens at
 * once; a new folder opens in the tree.
 */
import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { type Naming, useApp } from '../store';
import { Button } from '../ui/Button';
import { Dialog, DialogActions, Field, inputStyles } from '../ui/Dialog';

export function NameDialog({ request, onClose }: { request: Naming; onClose(): void }) {
  const notebook = useApp((state) => state.notebook)!;
  const folders = useApp((state) => state.info?.tree);
  const [name, setName] = useState(request.kind === 'rename' ? request.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const section = request.kind === 'section';
  const rename = request.kind === 'rename';
  const where = request.folder ? `in ${folderName(folders ?? [], request.folder) ?? request.folder}` : 'at the top of the notebook';

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (section) {
        const { id } = await api.createSection(name.trim(), request.folder);
        onClose();
        navigate({ page: 'section', id: notebook, section: id });
      } else {
        const before = new Set(paths(useApp.getState().info?.tree ?? []));
        if (rename) await api.renameFolder(request.folder, name.trim());
        else await api.createFolder(name.trim(), request.folder);
        const info = await api.repo();
        useApp.getState().setInfo(info);
        const made = paths(info.tree).find((path) => !before.has(path));
        const { setExpanded, expanded } = useApp.getState();
        if (made && rename) {
          // A renamed folder's directory is renamed too, so what was open stays open under its new path.
          for (const path of expanded) {
            if (path !== request.folder && !path.startsWith(`${request.folder}/`)) continue;
            setExpanded(path, false);
            setExpanded(made + path.slice(request.folder.length), true);
          }
          if (location.pathname.includes(`/f/${request.folder}`)) navigate({ page: 'notebook', id: notebook, folder: made }, { replace: true });
        } else if (made) {
          for (const path of [request.folder, made]) if (path) setExpanded(path, true);
        }
        onClose();
      }
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={section ? 'New section' : rename ? 'Rename folder' : 'New folder'} description={rename ? undefined : `It goes ${where}.`} onClose={onClose}>
      <form onSubmit={(event) => void save(event)}>
        <Field label={section ? 'Title' : 'Name'}>
          <input autoFocus required value={name} placeholder={section ? 'Such as Roadmap' : 'Such as Research'} onChange={(event) => setName(event.target.value)} className={inputStyles} />
        </Field>
        {error && (
          <p className="mt-3 text-[13px] text-removed" role="alert">
            {error}
          </p>
        )}
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {section ? 'Create section' : rename ? 'Rename' : 'Create folder'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

type Tree = NonNullable<ReturnType<typeof useApp.getState>['info']>['tree'];

/** Every folder's path in a tree. */
function paths(tree: Tree, parent = ''): string[] {
  return tree.flatMap((item) => (typeof item === 'string' ? [] : [`${parent}${item.folder}`, ...paths(item.items, `${parent}${item.folder}/`)]));
}

function folderName(tree: Tree, path: string): string | undefined {
  const [first, ...rest] = path.split('/');
  const folder = tree.find((item) => typeof item !== 'string' && item.folder === first);
  if (!folder || typeof folder === 'string') return undefined;
  return rest.length ? folderName(folder.items, rest.join('/')) : folder.name;
}
