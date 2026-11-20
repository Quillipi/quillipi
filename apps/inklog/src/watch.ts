import path from 'node:path';
import { watch } from 'chokidar';
import type { Engine } from '@inklog/engine';
import { LAYOUT } from '@inklog/engine';

/**
 * Passes edits that other programs make to section files, and to AGENTS.md with the AI
 * instructions, on to the engine. Returns a stop function.
 */
export function watchSections(engine: Engine, root: string): () => Promise<void> {
  const watcher = watch([path.join(root, LAYOUT.sections), path.join(root, LAYOUT.agents)], {
    ignoreInitial: true,
    // Wait until a file stops changing, so half-written files are never read.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const changed = (file: string) => {
    const rel = path.relative(root, file).split(path.sep).join('/');
    engine.fileChanged(rel).catch((error) => console.error(`Could not read ${rel}:`, error));
  };
  watcher.on('add', changed).on('change', changed).on('unlink', changed);
  return () => watcher.close();
}
