/**
 * A section, in the editor: the toolbar row, then the page with its margin, under the notebook's
 * tabs (NotebookDesk in App.tsx). Its history and Commit are in the History panel beside it.
 */
import { useEffect } from 'react';
import { Notice } from '../App';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { SectionView } from '../components/SectionView';
import { useLive } from '../live-context';
import { useApp } from '../store';

export function SectionPage({ section }: { section: string }) {
  const live = useLive();
  const exists = useApp((state) => state.info?.sections.some((candidate) => candidate.id === section));

  useEffect(() => {
    if (exists) useApp.getState().open(section);
  }, [section, exists]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ApprovalBanner />
      {exists ? <SectionView key={section} id={section} live={live} /> : <Notice title="This section isn't in the notebook">It may have been deleted, or moved to another notebook.</Notice>}
    </div>
  );
}
