// Files sent from the phone, in pieces that survive a bad network.
//
// A file attachment is a path on this machine; a file on a phone is not one,
// so it is uploaded first, beside the session's other uploads. In chunks, each
// stating the offset it starts at: when a link drops mid-file, the daemon says
// how much it already holds and the phone carries on from there. Every chunk
// is safe to send twice, so a retry never corrupts or duplicates anything.
import fs from 'node:fs';
import path from 'node:path';
import { baseDir } from './paths.js';

export const uploadsDir = path.join(baseDir, 'uploads');
/** Big enough for a log bundle or a screen recording, small enough not to fill the disk by accident. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface UploadChunk {
  sessionId: string;
  uploadId: string;
  name: string;
  offset: number;
  /** base64 */
  data: string;
  done?: boolean;
}

/** `received`: bytes held so far, where the next chunk must start. `path`: set once complete. */
export interface UploadProgress {
  received: number;
  path?: string;
}

/** A name that stays inside its directory and is still recognisably the file it was. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}

export function uploadChunk(chunk: UploadChunk, root: string = uploadsDir): UploadProgress {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(chunk.sessionId)) throw new Error('bad session id');
  if (!/^[A-Za-z0-9-]{1,80}$/.test(chunk.uploadId)) throw new Error('bad upload id');
  if (!Number.isInteger(chunk.offset) || chunk.offset < 0) throw new Error('bad offset');
  const dir = path.join(root, chunk.sessionId);
  const finalPath = path.join(dir, `${chunk.uploadId}-${safeName(chunk.name)}`);
  const partPath = path.join(dir, `.part-${chunk.uploadId}`);

  // Finished already: this is a retry of the last chunk whose answer was lost.
  if (fs.existsSync(finalPath)) return { received: fs.statSync(finalPath).size, path: finalPath };

  fs.mkdirSync(dir, { recursive: true });
  const held = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  // Not where we are: either a repeat of a chunk we have, or one after a gap.
  // Either way, say where to continue from and write nothing.
  if (chunk.offset !== held) return { received: held };

  const bytes = Buffer.from(chunk.data, 'base64');
  if (held + bytes.length > MAX_UPLOAD_BYTES) {
    fs.rmSync(partPath, { force: true });
    throw new Error(`file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }
  fs.appendFileSync(partPath, bytes);
  const received = held + bytes.length;
  if (!chunk.done) return { received };
  fs.renameSync(partPath, finalPath);
  return { received, path: finalPath };
}

/**
 * Give every image sent without a copy on disk one, beside the session's
 * other uploads. The editor saves its own; a phone sends only the bytes, so
 * without this the picture could never be opened again from the chat.
 */
export function keepImageCopies<A extends { kind: string; name?: string; data?: string; path?: string }>(
  sessionId: string,
  attachments: A[],
  root: string = uploadsDir,
): A[] {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sessionId)) return attachments;
  return attachments.map((a) => {
    if (a.kind !== 'image' || a.path || !a.data) return a;
    try {
      const dir = path.join(root, sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(a.name ?? 'image')}`);
      fs.writeFileSync(file, Buffer.from(a.data, 'base64'));
      return { ...a, path: file };
    } catch {
      return a; // a preview is a nicety; never fail the send over it
    }
  });
}

/**
 * Fill in the bytes of images sent by reference. A phone uploads a photo in
 * resumable chunks (four photos inline made one 8 MB request that a phone
 * link could not finish in time, and every retry began again) and then sends
 * only its path. Only paths inside the uploads directory are read: a message
 * must not be able to pull an arbitrary file off the disk into the model.
 */
export function loadImageData<A extends { kind: string; data?: string; path?: string }>(
  attachments: A[],
  root: string = uploadsDir,
): A[] {
  const base = path.resolve(root) + path.sep;
  return attachments.map((a) => {
    if (a.kind !== 'image' || a.data || !a.path) return a;
    const resolved = path.resolve(a.path);
    if (!resolved.startsWith(base)) throw new Error(`image ${a.path} is not an upload`);
    return { ...a, data: fs.readFileSync(resolved).toString('base64') };
  });
}
