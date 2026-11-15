import { selectMoveInstances, MoveSelectionError } from './move-query.js';
import { sendStoreForMove, validateMovePeer } from './move-transfer.js';

export class MoveRequestError extends Error {
  constructor(message,status) {super(message);this.status=status;}
}
// DICOM PS3.4: 0xA801 unknown Move Destination, 0xA702 unable to perform
// sub-operations, 0xC000 invalid identifier, 0xB000 suboperations warning.
export const MoveStatus=Object.freeze({
  Success:0x0000, Pending:0xFF00, Warning:0xB000,
  UnknownDestination:0xA801, SuboperationsFailed:0xA702, InvalidIdentifier:0xC000
});
export async function executeMove({dataset,destinationAet,catalog,peers,aet,
                                  send=sendStoreForMove,onProgress=()=>{}}) {
  if(typeof destinationAet!=='string' || !/^[A-Z0-9_-]{1,16}$/.test(destinationAet))
    throw new MoveRequestError('Invalid Move Destination',MoveStatus.UnknownDestination);
  const node=peers.get(destinationAet);
  try{validateMovePeer(node);} catch {
    throw new MoveRequestError('Unregistered or non-loopback Move Destination',MoveStatus.UnknownDestination);
  }
  let instances;
  try {instances=await selectMoveInstances(catalog.pool,dataset,{limit:10});}
  catch(error) {
    if(error instanceof MoveSelectionError)
      throw new MoveRequestError(error.message,error.code==='TOO_MANY_INSTANCES'
        ?MoveStatus.SuboperationsFailed:MoveStatus.InvalidIdentifier);
    throw error;
  }
  let completed=0,failed=0;
  const failedUIDs=[];
  for(let idx=0;idx<instances.length;idx++) {
    const instance=instances[idx];
    try {
      // The file is read only through checksum-verifying PACS storage.
      const bytes=await catalog.bytesFor(instance);
      await send({node,aet,bytes,instance});
      completed++;
    } catch {
      failed++;
      failedUIDs.push(instance.instance_uid);
    }
    // For each suboperation, emit a *pending* status only while others remain.
    if(idx<instances.length-1) {
      try{onProgress({status:MoveStatus.Pending,remaining:instances.length-idx-1,completed,failed,warnings:0});}
      catch {}
    }
  }
  const result={
    status:failed===0?MoveStatus.Success:MoveStatus.Warning,
    completed,failed,warnings:0,remaining:0,failedUIDs
  };
  try {
    await catalog.pool.query('INSERT INTO audit_events(event_type,reference_uid,details) VALUES($1,$2,$3)',
      ['move_request',dataset.StudyInstanceUID,JSON.stringify({
        destinationAet,completed,failed,level:dataset.QueryRetrieveLevel
      })]);
  } catch { // A failed audit must not be presented as a successful, clinically validated transfer.
    throw new MoveRequestError('Move audit failure',MoveStatus.SuboperationsFailed);
  }
  return result;
}
