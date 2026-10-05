import { api } from '../api';
import { basenameOf } from '../assetUsage';
import { useCutRoom } from './store';
import { withoutDeletedAssets } from './unusedAssets';
import type { Timeline } from './types';

/**
 * Library files were deleted from the disk: take their clipless entries out of every sequence's asset table,
 * so opening a film does not go looking for them. A clip's own asset stays (offline). The open cut room
 * and its parked tabs change in memory; every other sequence of every project is read, trimmed and saved.
 * Best effort: a sequence that cannot be saved keeps its stale entries, which the cut room marks offline.
 */
export async function dropDeletedFromTimelines(deleted: string[]): Promise<void> {
  if (deleted.length === 0) return;
  const names = new Set(deleted.map(basenameOf));
  useCutRoom.getState().dropDeletedAssets(names);
  try {
    const { projects } = await api.listProjects();
    for (const project of projects) {
      const cut = useCutRoom.getState();
      const { sequences } = await api.listSequences(project.id, true);
      for (const q of sequences) {
        if (cut.projectId === project.id && (q.id === cut.activeSeqId || cut.sessions[q.id])) continue;
        const saved = q.timeline as Timeline | null;
        if (!saved) continue;
        const next = withoutDeletedAssets(saved, names);
        if (next !== saved) await api.saveSequence(project.id, q.id, next, q.revision);
      }
    }
  } catch (e) {
    console.warn('could not drop deleted assets from the sequences', e);
  }
}
