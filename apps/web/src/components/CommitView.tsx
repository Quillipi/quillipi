import type { Block } from '@inklog/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';
import { snapshot } from '../api';
import { blocksToDoc } from '../editor/convert';
import { Margin } from '../editor/Margin';
import { editorExtensions } from '../editor/schema';
import { useApp } from '../store';

/** A section as it was in a past commit, with that commit's changes in the margin. */
export function CommitView({ commit, section, onRestore }: { commit: string; section: string; onRestore(blocks: Block[]): void }) {
  const commits = useApp((state) => state.info?.commits ?? []);
  const viewCommit = useApp((state) => state.viewCommit);
  const compare = useApp((state) => state.compare);
  const index = commits.findIndex((candidate) => candidate.oid === commit);
  const summary = commits[index];
  const parent = commits[index + 1];
  const [versions, setVersions] = useState<{ at?: Block[]; before: Block[] }>();

  useEffect(() => {
    let current = true;
    setVersions(undefined);
    void Promise.all([snapshot(commit), parent ? snapshot(parent.oid) : Promise.resolve<Record<string, Block[]>>({})]).then(
      ([at, before]) => current && setVersions({ at: at[section], before: before[section] ?? [] }),
    );
    return () => {
      current = false;
    };
  }, [commit, section, parent?.oid]);

  if (!summary) return null;
  return (
    <>
      <div className="banner">
        <span>
          #{summary.number} “{summary.message}”, {summary.agent ? `${summary.agent} for ${summary.author}` : summary.author}, {new Date(summary.at).toLocaleString()}
        </span>
        {versions?.at && (
          <button type="button" onClick={() => (onRestore(versions.at!), viewCommit(undefined))}>
            Restore this version
          </button>
        )}
        <button type="button" onClick={() => compare(commit)}>
          Compare with now
        </button>
        <button type="button" className="primary" onClick={() => viewCommit(undefined)}>
          Back to now
        </button>
      </div>
      {!versions ? (
        <p className="notice muted">Loading #{summary.number}…</p>
      ) : versions.at ? (
        <ReadOnlyVersion blocks={versions.at} before={versions.before} section={section} />
      ) : (
        <p className="notice">This section didn't exist yet in #{summary.number}.</p>
      )}
    </>
  );
}

function ReadOnlyVersion({ blocks, before, section }: { blocks: Block[]; before: Block[]; section: string }) {
  const extensions = useMemo(editorExtensions, []);
  const editor = useEditor({ extensions, content: blocksToDoc(blocks), editable: false }, [blocks]);
  if (!editor) return null;
  return (
    <div className="workspace past">
      <div className="page">
        <Margin editor={editor} base={before} section={section} pending={[]} readOnly />
        <EditorContent editor={editor} className="document" />
      </div>
    </div>
  );
}
