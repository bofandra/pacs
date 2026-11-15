import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMove,selectMoveInstances, MoveSelectionError } from '../src/move-query.js';
import { executeMove,MoveStatus,MoveRequestError } from '../src/move-scp.js';
import { validateMovePeer } from '../src/move-transfer.js';

const instance=(suffix)=>({
  study_uid:'1.2.3',series_uid:'1.2.3.4',instance_uid:'1.2.3.4.'+suffix,
  sop_class_uid:'1.2.840.10008.5.1.4.1.1.1',
  transfer_syntax_uid:'1.2.840.10008.1.2.1',sha256:'0'.repeat(64)
});
const peer={aet:'DEST_SCP',host:'127.0.0.1',port:32191,enabled:true};
const peers=new Map([['DEST_SCP',peer]]);
const selection={QueryRetrieveLevel:'STUDY',StudyInstanceUID:'1.2.3'};
function fakeCatalog(rows){
  let audit=[];
  return {
    audit,
    pool:{query:async (sql,args)=>{
      if(sql.startsWith('SELECT i.study_uid'))return {rows};
      if(sql.startsWith('INSERT INTO audit_events')) {audit.push(args);return {rows:[]};}
      throw Error('unexpected query');
    }},
    bytesFor:async()=>Buffer.from('SYNTHETIC-DICOM')
  };
}
test('Study Root MOVE enforces UID hierarchy and rejects extra keys',()=>{
  assert.deepEqual(normalizeMove(selection),{level:'STUDY',StudyInstanceUID:'1.2.3'});
  assert.throws(()=>normalizeMove({QueryRetrieveLevel:'STUDY'}),/StudyInstanceUID/);
  assert.throws(()=>normalizeMove({QueryRetrieveLevel:'SERIES',StudyInstanceUID:'1.2.3'}),/SeriesInstanceUID/);
  assert.throws(()=>normalizeMove({QueryRetrieveLevel:'IMAGE',StudyInstanceUID:'1.2.3',
    SeriesInstanceUID:'1.2.3.4'}),/SOPInstanceUID/);
  assert.throws(()=>normalizeMove({...selection,PatientName:'*'}),/Unsupported/);
  assert.throws(()=>normalizeMove({...selection,StudyInstanceUID:'*'}),/invalid/);
  assert.throws(()=>validateMovePeer({...peer,host:'192.0.2.1'}),/NOT_ALLOWED/);
  assert.deepEqual(validateMovePeer(peer),peer);
});
test('bounded selection constrains exact study/series/image UIDs using parameters',async()=>{
  let params;
  const pool={query:async (sql,args)=>{params=args;assert.ok(sql.includes('i.study_uid=$1'));return {rows:[instance(1)]};}};
  const rows=await selectMoveInstances(pool,{QueryRetrieveLevel:'IMAGE',StudyInstanceUID:'1.2.3',
    SeriesInstanceUID:'1.2.3.4',SOPInstanceUID:'1.2.3.4.1'});
  assert.equal(rows.length,1);
  assert.deepEqual(params,['1.2.3','1.2.3.4','1.2.3.4.1',11]);
  const tooMany={query:async()=>({rows:Array.from({length:11},(_,i)=>instance(i+1))})};
  await assert.rejects(selectMoveInstances(tooMany,selection),e=>
    e instanceof MoveSelectionError&&e.code==='TOO_MANY_INSTANCES');
});
test('MOVE counts C-STORE acknowledgments and reports pending/final status',async()=>{
  const catalog=fakeCatalog([instance(1),instance(2)]);
  const sent=[],progress=[];
  const result=await executeMove({
    dataset:selection,destinationAet:'DEST_SCP',catalog,peers,aet:'PACS_NATIVE',
    send:async ({instance})=>{sent.push(instance.instance_uid);return {status:'success'};},
    onProgress:p=>progress.push(p)
  });
  assert.equal(result.status,MoveStatus.Success);
  assert.equal(result.completed,2);assert.equal(result.failed,0);
  assert.deepEqual(sent,['1.2.3.4.1','1.2.3.4.2']);
  assert.deepEqual(progress,[{status:MoveStatus.Pending,remaining:1,completed:1,failed:0,warnings:0}]);
  assert.equal(catalog.audit.length,1);
});
test('MOVE partial transport failure never reports success',async()=>{
  const catalog=fakeCatalog([instance(1),instance(2)]);
  const result=await executeMove({
    dataset:selection,destinationAet:'DEST_SCP',catalog,peers,aet:'PACS_NATIVE',
    send:async({instance})=>{if(instance.instance_uid.endsWith('1'))throw new Error('synthetic association failure');}
  });
  assert.equal(result.status,MoveStatus.Warning);
  assert.equal(result.completed,1);assert.equal(result.failed,1);
  assert.deepEqual(result.failedUIDs,['1.2.3.4.1']);
});
test('MOVE blocks unregistered destinations and broad queries without sending',async()=>{
  const catalog=fakeCatalog([instance(1)]);
  let sent=false;
  await assert.rejects(executeMove({
    dataset:selection,destinationAet:'UNKNOWN',catalog,peers,aet:'PACS_NATIVE',
    send:async()=>{sent=true;}
  }),e=>e instanceof MoveRequestError&&e.status===MoveStatus.UnknownDestination);
  await assert.rejects(executeMove({
    dataset:{QueryRetrieveLevel:'STUDY'},destinationAet:'DEST_SCP',catalog,peers,aet:'PACS_NATIVE',
    send:async()=>{sent=true;}
  }),e=>e instanceof MoveRequestError&&e.status===MoveStatus.InvalidIdentifier);
  assert.equal(sent,false);
});
