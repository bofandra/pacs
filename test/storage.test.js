import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256,storeObject,readObject,objectPath } from '../src/storage.js';

test('store DICOM bytes, retrieve original and deduplicate safely',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pacs-storage-'));
  try {
    const bytes=Buffer.from('fake test bytes; never use in clinical setting');
    const first=await storeObject(root,bytes);
    const second=await storeObject(root,bytes);
    assert.equal(first.sha256,sha256(bytes));
    assert.deepEqual(first,second);
    assert.deepEqual(await readObject(root,first.sha256),bytes);
    await fs.writeFile(objectPath(root,first.sha256),Buffer.from('tampered'));
    await assert.rejects(readObject(root,first.sha256),/checksum mismatch/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('reject invalid object digest',()=>{
  assert.throws(()=>objectPath('/tmp','../etc/passwd'),/Invalid SHA-256/);
});
