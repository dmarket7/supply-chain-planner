import { api } from '../../lib/api';

/**
 * Replays every kept Supplier PO report oldest first, a batch of POs per request (see the
 * /imports/rebuild routes). Needed after importing an older report or deleting one.
 */
export async function rebuildPoHistory(onProgress: (done: number, total: number) => void): Promise<void> {
  const { batches } = await api<{ batches: string[][] }>('/imports/rebuild', { method: 'POST', body: '{}' });
  onProgress(0, batches.length);
  for (const [i, groups] of batches.entries()) {
    await api('/imports/rebuild/batch', { method: 'POST', body: JSON.stringify({ groups }) });
    onProgress(i + 1, batches.length);
  }
  await api('/imports/rebuild/finish', { method: 'POST', body: '{}' });
}
