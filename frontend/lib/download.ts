/** Bytes received so far and the file's size, 0 when the server did not say. */
export type DownloadProgress = (done: number, total: number) => void;

/** The file a save-picker handle writes to; the part of FileSystemWritableFileStream used here. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

const sizeOf = (response: Response) => Number(response.headers.get('content-length')) || 0;

/**
 * A response body read in pieces into one Blob, reporting progress as it goes.
 * `response.blob()` reports nothing until the whole file is in memory, which on a
 * 400 MB export is minutes of a button that looks dead.
 */
export async function readResponse(response: Response, onProgress?: DownloadProgress): Promise<Blob> {
  const total = sizeOf(response);
  const type = response.headers.get('content-type') || '';
  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(blob.size, total || blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    done += step.value.length;
    onProgress?.(done, total);
  }
  return new Blob(chunks as BlobPart[], { type });
}

/**
 * A response body written straight to a file as it arrives: nothing is held in
 * memory, so the size of the file does not matter. Returns the bytes written.
 */
export async function writeResponse(
  response: Response,
  sink: ByteSink,
  onProgress?: DownloadProgress,
): Promise<number> {
  const total = sizeOf(response);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await sink.write(bytes);
    await sink.close();
    onProgress?.(bytes.length, total || bytes.length);
    return bytes.length;
  }
  const reader = response.body.getReader();
  let done = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    await sink.write(step.value);
    done += step.value.length;
    onProgress?.(done, total);
  }
  await sink.close();
  return done;
}

/** "43% · 172 / 400 MB", or just the megabytes received when the size is unknown. */
export function describeProgress(done: number, total: number): string {
  const mb = (bytes: number) => (bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1);
  if (!total) return `${mb(done)} MB`;
  return `${Math.min(100, Math.floor((done / total) * 100))}% · ${mb(done)} / ${mb(total)} MB`;
}

/**
 * The address that makes the browser itself download a file the backend serves, or null for anything else.
 *
 * Saving from the page means holding the whole file in memory first, and a phone browser reloads the tab
 * well before 388 MB. The backend's /download answers with Content-Disposition: attachment, so a plain
 * link click hands the file to the browser's download manager: nothing is buffered here.
 */
export function nativeDownloadUrl(url: string, name: string, backendUrl: string): string | null {
  let path: string;
  try {
    if (url.startsWith('/')) path = url;
    else if (url.startsWith(`${backendUrl}/`)) path = new URL(url).pathname;
    else return null;
  } catch {
    return null;
  }
  if (!path.startsWith('/uploads/') && !path.startsWith('/comfy_output/')) return null;
  return `${backendUrl}/download?src=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
}
