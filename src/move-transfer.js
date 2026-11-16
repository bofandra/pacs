// C-MOVE sub-operation transport using DICOM C-STORE on a NEW association to the AE destination.
// Separate from PACS routing queue: a C-MOVE request requires synchronous completion counts.
// Development only. No network egress outside loopback.
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendStoreFile } from './store-transfer.js';

export class MoveTransportError extends Error {
  constructor(code) {super(code);this.code=code;}
}
const supportedOriginalSyntax=new Set([
  '1.2.840.10008.1.2','1.2.840.10008.1.2.1'
]);
export function validateMovePeer(node) {
  if(!node?.enabled || node.host!=='127.0.0.1' || net.isIP(node.host)!==4
    || !/^[A-Z0-9_-]{1,16}$/.test(node.aet)
    || !Number.isInteger(node.port) || node.port<1024 || node.port>65535)
    throw new MoveTransportError('DESTINATION_NOT_ALLOWED');
  return node;
}
export async function sendStoreForMove({node,aet,bytes,instance,timeoutMs=15000}) {
  validateMovePeer(node);
  if(!supportedOriginalSyntax.has(instance.transfer_syntax_uid))
    throw new MoveTransportError('TRANSFER_SYNTAX_UNSUPPORTED');
  if(!Buffer.isBuffer(bytes) || bytes.length===0)throw new MoveTransportError('INVALID_OBJECT');
  // Preserve the Part 10 file until C-STORE acknowledgement.
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pacs-move-'));
  const sourcePath=path.join(dir,'instance.dcm');
  try {
    await fs.writeFile(sourcePath,bytes,{flag:'wx',mode:0o600});
    return await sendStoreFile({node,aet,sourcePath,timeoutMs});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
