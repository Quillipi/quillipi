import { type Block, byId, sameContent } from './blocks.js';
import { unmovedIds } from './diff.js';

/** Key for the removal of a block, as opposed to an edit or move of it. */
export function removalKey(id: string): string {
  return `removed:${id}`;
}

/**
 * The version of a section to commit when only some changes are included. Included changes
 * are applied to `base`; the rest stay as they were in `base`, and so stay uncommitted.
 * `included` is asked about block IDs (for added, edited and moved blocks) and removal keys.
 */
export function stagedBlocks(base: readonly Block[], work: readonly Block[], included: (key: string) => boolean): Block[] {
  const workById = byId(work);
  const staged: Block[] = [];
  for (const block of base) {
    const current = workById.get(block.id);
    if (!current) {
      if (!included(removalKey(block.id))) staged.push(block);
    } else {
      staged.push(!sameContent(block, current) && included(block.id) ? current : block);
    }
  }

  // Included additions and moves go after the nearest earlier block of `work` that sits in the
  // same place in the staged version. A moved block whose move is excluded is not in place.
  const unmoved = unmovedIds(base, work);
  const inPlace = (id: string) => unmoved.has(id) || included(id);
  work.forEach((block, index) => {
    if (unmoved.has(block.id) || !included(block.id)) return;
    const existing = staged.findIndex((candidate) => candidate.id === block.id);
    const content = existing >= 0 ? staged.splice(existing, 1)[0] : block;
    let at = 0;
    for (let k = index - 1; k >= 0; k--) {
      const position = staged.findIndex((candidate) => candidate.id === work[k].id);
      if (position >= 0 && inPlace(work[k].id)) {
        at = position + 1;
        break;
      }
    }
    staged.splice(at, 0, content);
  });
  return staged;
}
