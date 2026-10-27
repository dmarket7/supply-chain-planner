import { api } from '../../lib/api';

/**
 * The import routes' create → chunks → complete pattern: POST `create` returns the new id under
 * `idKey`, each chunk posts `{ [field]: items }` to `<base>/<id>/<chunkPath>`, then `<base>/<id>/complete`.
 */
export async function uploadChunked<R>(opts: {
  base: string;
  start: object;
  idKey: string;
  chunkPath: string;
  field: string;
  items: unknown[];
  size: number;
  onProgress: (done: number, total: number) => void;
}): Promise<R> {
  const created = await api<Record<string, number>>(opts.base, { method: 'POST', body: JSON.stringify(opts.start) });
  const id = created[opts.idKey];
  opts.onProgress(0, opts.items.length);
  for (let i = 0; i < opts.items.length; i += opts.size) {
    const part = opts.items.slice(i, i + opts.size);
    await api(`${opts.base}/${id}/${opts.chunkPath}`, { method: 'POST', body: JSON.stringify({ [opts.field]: part }) });
    opts.onProgress(i + part.length, opts.items.length);
  }
  return api<R>(`${opts.base}/${id}/complete`, { method: 'POST', body: '{}' });
}
