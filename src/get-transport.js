// The C-GET receiver is the original association requester. No new TCP socket.
// Never report success until a C-STORE-RSP is received for the selected SOP instance.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dimsePackage from 'dcmjs-dimse';

const {CStoreRequest}=dimsePackage.requests;
const {Status}=dimsePackage.constants;
export async function storeOnGetAssociation(scp,{bytes,instance,timeoutMs=15000}) {
  if(!Buffer.isBuffer(bytes)||bytes.length===0)throw new Error('Invalid DICOM object');
  if(!scp?.association || !scp?.connected || scp.socket?.destroyed)
    throw new Error('C-GET association closed');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pacs-get-'));
  try {
    const file=path.join(dir,'instance.dcm');
    await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
    const request=new CStoreRequest(file);
    if(request.getAffectedSopInstanceUid()!==instance.instance_uid)
      throw new Error('Unexpected SOP Instance UID');
    return await new Promise((resolve,reject)=>{
      let done=false;
      const finish=(success)=>{
        if(done)return;
        done=true;
        clearTimeout(timer);
        scp.off('close',closed);
        scp.off('networkError',failed);
        if(success)resolve({status:'success'});
        else reject(new Error('C-STORE suboperation not acknowledged'));
      };
      const closed=()=>finish(false);
      const failed=()=>finish(false);
      const timer=setTimeout(()=>finish(false),timeoutMs);
      request.on('response',response=>finish(response.getStatus()===Status.Success));
      scp.once('close',closed);
      scp.once('networkError',failed);
      try {
        // Network.sendRequests uses this socket and its accepted presentation contexts.
        scp.sendRequests(request);
      }catch{finish(false);}
    });
  }finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
}
