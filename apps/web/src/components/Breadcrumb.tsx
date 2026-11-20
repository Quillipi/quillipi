import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { follow } from '../frame/Rail';
import { folderName } from '../frame/NotebookTree';
import { href } from '../router';
import { useApp } from '../store';

/** Where the section is, small above its title: the notebook, then its folders. Each part opens its page. */
export function Breadcrumb({ section }: { section: string }) {
  const info = useApp((state) => state.info);
  const notebook = useApp((state) => state.notebook);
  const found = info?.sections.find((candidate) => candidate.id === section);
  if (!info || !notebook || !found) return null;
  const parts = found.folder ? found.folder.split('/') : [];
  const link = 'rounded-sm outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <nav aria-label="Where this section is" className="col-start-2 mb-3 flex min-w-0 flex-wrap items-center gap-1 font-sans text-[12.5px] text-muted-foreground">
      <a className={link} href={href({ page: 'notebook', id: notebook, folder: '' })} onClick={follow}>
        {info.name}
      </a>
      {parts.map((_, index) => {
        const path = parts.slice(0, index + 1).join('/');
        return (
          <Fragment key={path}>
            <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />
            <a className={link} href={href({ page: 'notebook', id: notebook, folder: path })} onClick={follow}>
              {folderName(info.tree, path)}
            </a>
          </Fragment>
        );
      })}
    </nav>
  );
}
