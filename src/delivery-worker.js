import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { PacsCatalog } from './catalog.js';
import { claimJob,finishJob } from './routing.js';
import { sendDicomNative } from './delivery-transport.js';

export function safeDeliveryError(error) {
  // Never persist raw DIMSE errors: native log output may contain patient identifiers.
  const codes=new Set(['DIMSE_TIMEOUT','DIMSE_PROCESS_ERROR','DIMSE_ASSOCIATION_FAILED','AE_DISABLED','CHECKSUM_MISMATCH']);
  return codes.has(error?.code)?error.code:'DELIVERY_FAILED';
}
export async function processDeliveryJob(catalog,send=sendDicomNative) {
  const job=await claimJob(catalog.pool);
  if(!job) return null;
  const conf=catalog.conf;
  let stage;
  try {
    const node=await catalog.node(job.destination_aet);
    if(!node) throw Object.assign(new Error('Destination AE disabled'),{code:'AE_DISABLED'});
    const res=await catalog.pool.query('SELECT sha256 FROM instances WHERE instance_uid=$1',[job.instance_uid]);
    if(!res.rowCount) throw new Error('Instance missing from catalog');
    let bytes;
    try {bytes=await catalog.bytesFor(res.rows[0]);}
    catch {throw Object.assign(new Error('Object storage error'),{code:'CHECKSUM_MISMATCH'});}
    const outbound=path.join(conf.inboxRoot,'outgoing');
    await fs.mkdir(outbound,{recursive:true,mode:0o700});
    stage=await fs.mkdtemp(path.join(outbound,'send-'));
    await fs.writeFile(path.join(stage,'instance.dcm'),bytes,{flag:'wx',mode:0o600});
    await send({conf,node,sourcePath:stage,job});
    const finished=await finishJob(catalog.pool,job,true);
    return {jobId:Number(job.id),status:finished?.status??'lease_lost'};
  } catch(error) {
    const finished=await finishJob(catalog.pool,job,false,safeDeliveryError(error));
    return {jobId:Number(job.id),status:finished?.status??'lease_lost',errorCode:safeDeliveryError(error)};
  } finally {
    if(stage) await fs.rm(stage,{recursive:true,force:true});
  }
}
async function main(){
  const catalog=new PacsCatalog(config());
  let stopping=false;
  process.once('SIGINT',()=>{stopping=true;});
  process.once('SIGTERM',()=>{stopping=true;});
  console.log('PACS delivery worker running (at-least-once semantics)');
  try {
    while(!stopping) {
      const result=await processDeliveryJob(catalog).catch(error=>{
        console.error('Delivery worker database/processing error:',error?.code??'UNKNOWN');
        return null;
      });
      if(result) console.log('delivery',result.jobId,result.status,result.errorCode??'');
      if(!result) await new Promise(resolve=>setTimeout(resolve,3000));
    }
  } finally {await catalog.close();}
}
if(process.argv[1] && import.meta.url===new URL('file://'+path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error('Delivery worker stopped:',error?.code??'UNKNOWN');process.exitCode=1;});
}
