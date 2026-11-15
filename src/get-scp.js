// Strict experimental Study Root C-GET orchestration.
// C-STORE is sent over the REQUESTER'S EXISTING DIMSE ASSOCIATION.
import { selectMoveInstances,MoveSelectionError } from './move-query.js';

export const GetStatus=Object.freeze({
  Success:0x0000,Pending:0xff00,Warning:0xb000,
  OutOfResources:0xa702,InvalidIdentifier:0xc000
});
export class GetRequestError extends Error {
  constructor(reason,status=GetStatus.OutOfResources) {super(reason);this.status=status;}
}
const supportedStorage=new Set([
  '1.2.840.10008.5.1.4.1.1.1', // Computed Radiography
  '1.2.840.10008.5.1.4.1.1.1.1', // Digital X-ray for presentation
  '1.2.840.10008.5.1.4.1.1.2', // CT
  '1.2.840.10008.5.1.4.1.1.4' // MR
]);
const supportedSyntax=new Set(['1.2.840.10008.1.2','1.2.840.10008.1.2.1']);
export function canAcceptStorageContext(ctx) {
  if(!ctx || !supportedStorage.has(ctx.getAbstractSyntaxUid()))return false;
  // A C-GET SCU must explicitly propose the SCP role for C-STORE.
  if(ctx.getProviderRole()!==true)return false;
  if(!ctx.getTransferSyntaxUids().some(uid=>supportedSyntax.has(uid)))return false;
  return true;
}
export function acceptedStoreContext(association,instance) {
  if(!supportedStorage.has(instance?.sop_class_uid) ||
     !supportedSyntax.has(instance?.transfer_syntax_uid))return null;
  if(!association)return null;
  return association.getPresentationContexts()
    .map(entry=>entry.context)
    .find(ctx=>ctx.getAbstractSyntaxUid()===instance.sop_class_uid &&
       ctx.getResult()===0 && ctx.getProviderRole()===true &&
       ctx.getAcceptedTransferSyntaxUid()===instance.transfer_syntax_uid)??null;
}
export async function executeGet({dataset,catalog,association,send,onProgress=()=>{},limit=10}) {
  let instances;
  try {instances=await selectMoveInstances(catalog.pool,dataset,{limit});}
  catch(error){
    if(error instanceof MoveSelectionError)
      throw new GetRequestError('Invalid or oversized C-GET selection',
        error.code==='TOO_MANY_INSTANCES'?GetStatus.OutOfResources:GetStatus.InvalidIdentifier);
    throw error;
  }
  let completed=0,failed=0;
  const failedUIDs=[];
  for(let i=0;i<instances.length;i++){
    const instance=instances[i];
    try {
      if(!acceptedStoreContext(association,instance))throw new Error('No negotiated storage role/transfer syntax');
      const bytes=await catalog.bytesFor(instance); // checksum-verified original
      const ack=await send({instance,bytes});
      if(ack?.status!=='success')throw new Error('C-STORE not acknowledged');
      completed++;
    }catch {
      failed++;failedUIDs.push(instance.instance_uid);
    }
    if(i<instances.length-1)
      onProgress({status:GetStatus.Pending,remaining:instances.length-i-1,completed,failed,warnings:0});
  }
  // The audit write must succeed before a successful final DIMSE response.
  try {
    await catalog.pool.query(
      'INSERT INTO audit_events(event_type,reference_uid,details) VALUES($1,$2,$3)',
      ['get_request',dataset.StudyInstanceUID,JSON.stringify({
        level:dataset.QueryRetrieveLevel,completed,failed
      })]);
  } catch {throw new GetRequestError('C-GET audit failed');}
  return {
    status:failed===0?GetStatus.Success:GetStatus.Warning,
    completed,failed,warnings:0,remaining:0,failedUIDs
  };
}
