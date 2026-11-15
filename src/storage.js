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
  try {
    await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
    // Flush file contents before declaring storage durable (filesystem durability depends on mount).
    const handle = await fs.open(dest, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const existing = await fs.readFile(dest);
    if (sha256(existing) !== digest) throw new Error('Stored object checksum mismatch');
  }
  return { sha256: digest, bytes: bytes.length };
}
export async function readObject(root, digest) {
  const bytes = await fs.readFile(objectPath(root, digest));
  if (sha256(bytes) !== digest) throw new Error('Stored object checksum mismatch');
  return bytes;
}
