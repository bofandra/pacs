// C-MOVE sub-operation transport using DICOM C-STORE on a NEW association to the AE destination.
// Separate from PACS routing queue: a C-MOVE request requires synchronous completion counts.
// Development only. No network egress outside loopback.
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dimse from 'dcmjs-dimse';

const {Client}=dimse;
const {CStoreRequest}=dimse.requests;
const {Status}=dimse.constants;
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
  // Native C-STORE SCU reads the Part 10 file lazily; preserve it until C-STORE acknowledgment.
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pacs-move-'));
  const sourcePath=path.join(dir,'instance.dcm');
  try {
    await fs.writeFile(sourcePath,bytes,{flag:'wx',mode:0o600});
    return await new Promise((resolve,reject)=>{
      const client=new Client();
      const request=new CStoreRequest(sourcePath);
      let done=false;
      const finish=(ok,code)=>{
        if(done)return;
        done=true;clearTimeout(timer);
        try{client.network?.close();}catch{}
        if(ok)resolve({status:'success'});
        else reject(new MoveTransportError(code));
      };
      const timer=setTimeout(()=>finish(false,'STORE_TIMEOUT'),timeoutMs);
      request.on('response',response=>{
        if(response.getStatus()===Status.Success)finish(true);
        else finish(false,'STORE_RESPONSE_FAILURE');
      });
      client.on('associationRejected',()=>finish(false,'STORE_ASSOCIATION_REJECTED'));
      client.on('networkError',()=>finish(false,'STORE_NETWORK_ERROR'));
      client.on('closed',()=>finish(false,'STORE_CLOSED_PREMATURELY'));
      client.addRequest(request);
      try{
        client.send(node.host,node.port,aet,node.aet,{
          connectTimeout:Math.min(timeoutMs,10000),
          associationTimeout:Math.min(timeoutMs,10000),
          pduTimeout:Math.min(timeoutMs,10000),
          logCommandDatasets:false,logDatasets:false
        });
      }catch{finish(false,'STORE_SEND_FAILED');}
    });
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
