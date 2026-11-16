import test from 'node:test';
import assert from 'node:assert/strict';
import {canAcceptStorageContext,acceptedStoreContext,executeGet,GetStatus,GetRequestError} from '../src/get-scp.js';
const sop='1.2.840.10008.5.1.4.1.1.1';
const syntax='1.2.840.10008.1.2.1';
const row={
  study_uid:'1.2.3',series_uid:'1.2.4',instance_uid:'1.2.5',
  sop_class_uid:sop,transfer_syntax_uid:syntax,sha256:'0'.repeat(64)
};
const dataset={QueryRetrieveLevel:'STUDY',StudyInstanceUID:'1.2.3'};
function context({provider=true,result=0,accepted=syntax,abstract=sop,proposals=[syntax]}={}){
  return {
    getAbstractSyntaxUid:()=>abstract,getProviderRole:()=>provider,
    getTransferSyntaxUids:()=>proposals,getAcceptedTransferSyntaxUid:()=>accepted,
    getResult:()=>result
  };
}
const assoc=(...contexts)=>({getPresentationContexts:()=>contexts.map((c,i)=>({id:i*2+1,context:c}))});
function catalog(rows=[row]){
  const events=[];
  return {
    events,
    pool:{query:async(sql,args)=>{
      if(sql.startsWith('SELECT i.study_uid'))return {rows};
      if(sql.startsWith('INSERT INTO audit_events')){events.push(args);return {rows:[]};}
      throw Error('Unexpected SQL');
    }},
    bytesFor:async()=>Buffer.from('synthetic')
  };
}
test('C-GET storage contexts require explicit reverse role, known SOP and exact syntax',()=>{
  assert.equal(canAcceptStorageContext(context()),true);
  assert.equal(canAcceptStorageContext(context({provider:false})),false);
  assert.equal(canAcceptStorageContext(context({abstract:'9.9.9'})),false);
  assert.equal(canAcceptStorageContext(context({proposals:['1.2.3.4']})),false);
  assert.ok(acceptedStoreContext(assoc(context()),row));
  assert.equal(acceptedStoreContext(assoc(context({provider:false})),row),null);
  assert.equal(acceptedStoreContext(assoc(context({accepted:'1.2.840.10008.1.2'})),row),null);
  assert.equal(acceptedStoreContext(assoc(context({result:1})),row),null);
});
test('C-GET success counts only confirmed same-association C-STORE and logs audit',async()=>{
  const c=catalog();let sent=0;
  const outcome=await executeGet({
    dataset,catalog:c,association:assoc(context()),
    send:async({instance,bytes})=>{
      sent++;assert.equal(instance.instance_uid,row.instance_uid);
      assert.ok(Buffer.isBuffer(bytes));
      return {status:'success'};
    }
  });
  assert.equal(sent,1);assert.equal(outcome.status,GetStatus.Success);
  assert.equal(outcome.completed,1);assert.equal(outcome.failed,0);
  assert.equal(c.events.length,1);
});
test('C-GET never reports success on missing storage role or bad C-STORE RSP',async()=>{
  const c=catalog();
  const blocked=await executeGet({
    dataset,catalog:c,association:assoc(context({provider:false})),
    send:async()=>{throw Error('must not send');}
  });
  assert.equal(blocked.status,GetStatus.Warning);
  assert.equal(blocked.completed,0);assert.equal(blocked.failed,1);
  const rejected=await executeGet({
    dataset,catalog:c,association:assoc(context()),
    send:async()=>({status:'failure'})
  });
  assert.equal(rejected.status,GetStatus.Warning);
  assert.deepEqual(rejected.failedUIDs,[row.instance_uid]);
});
test('C-GET rejects missing StudyInstanceUID instead of selecting an entire archive',async()=>{
  const c=catalog();
  await assert.rejects(executeGet({
    dataset:{QueryRetrieveLevel:'STUDY'},catalog:c,association:assoc(context()),
    send:async()=>({status:'success'})
  }),error=>error instanceof GetRequestError&&error.status===GetStatus.InvalidIdentifier);
});
