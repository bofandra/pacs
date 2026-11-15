import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
export function objectPath(root, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid SHA-256');
  return path.join(root, digest.slice(0, 2), digest.slice(2, 4), digest + '.dcm');
}
export async function storeObject(root, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Empty DICOM input');
  const digest = sha256(bytes);
  const dest = objectPath(root, digest);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Never expose a partially-written content-addressed object. Link only after fsync.
  const tmp = dest + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let linked = false;
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await fs.link(tmp, dest); // atomic, no overwrite if another writer won
      linked = true;
    } catch(err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (!linked) {
      const existing = await fs.readFile(dest);
      if (sha256(existing) !== digest) throw new Error('Stored object checksum mismatch');
    }
    // Make directory entry durable where supported by the underlying filesystem.
    const dirHandle = await fs.open(path.dirname(dest), 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } finally {
    await fs.unlink(tmp).catch(err => { if(err.code !== 'ENOENT') throw err; });
  }
  return { sha256: digest, bytes: bytes.length };
}
export async function readObject(root, digest) {
  const bytes = await fs.readFile(objectPath(root, digest));
  if (sha256(bytes) !== digest) throw new Error('Stored object checksum mismatch');
  return bytes;
}
