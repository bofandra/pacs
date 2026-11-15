import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {startMwlScp} from '../src/mwl-scp.js';

const execFile=promisify(execFileCallback);
const enabled=process.env.PACS_INTEGRATION==='1'&&process.env.PACS_DCMTK==='1';
const base='http://127.0.0.1:32194';
const token='test-only-strong-token-not-for-clinical-use';
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
async function api(path,{method='GET',body}={}) {
 const response=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
 return {response,data:await response.json()};
}
function syntheticOrder(index,issuer,modality='CT') {
 return {
   sourceSystem:'RIS_SIM',externalOrderId:'SYNTH-ORDER-'+index,
   accessionIssuer:issuer,accessionNumber:'MWLACC'+index.toString().padStart(6,'0'),
   patientId:'MWLTEST123',issuerOfPatientId:issuer,
   patientName:'SYNTHETIC^WORKLIST',patientBirthDate:'19800704',patientSex:'F',
   studyInstanceUID:'2.25.987654321'+index,
   requestedProcedureId:'RP'+index,requestedProcedureDescription:'Synthetic radiology order',
   scheduledProcedureStepId:'SPS'+index,
   scheduledProcedureStepDescription:'Synthetic CT study',
   scheduledStationAETitle:'MWL_TEST_AE',modality,
   scheduledStartDate:'20261116',scheduledStartTime:'103000',
   scheduleTimezone:'Asia/Jakarta'
 };
}
test('RIS scheduling API to DICOM MWL C-FIND, identifier issuer and cancellation',
  {skip:!enabled,timeout:35000},async()=>{
 const server=spawn(process.execPath,['src/server.js'],{
   cwd:process.cwd(),
   env:{...process.env,HTTP_HOST:'127.0.0.1',HTTP_PORT:'32194',API_TOKEN:token},
   stdio:'ignore'
 });
 let mwl;
 try {
   let ready=false;
   for(let i=0;i<60;i++){
     if(server.exitCode!==null)throw new Error('HTTP server unexpectedly exited');
     try{const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}
     await delay(120);
   }
   assert.equal(ready,true);
   const node=await api('/api/v1/aes/MWL_TEST_AE',{method:'PUT',
     body:{host:'127.0.0.1',port:32193,enabled:true}});
   assert.equal(node.response.status,200);
   const primary=syntheticOrder(101,'ISSUER_A');
   const second=syntheticOrder(102,'ISSUER_B');
   const cancelled=syntheticOrder(103,'ISSUER_A','MR');
   const created=await api('/api/v1/ris/worklist-orders',{method:'POST',body:primary});
   assert.equal(created.response.status,201);
   assert.equal(created.data.order.accession_number,primary.accessionNumber);
   assert.equal(created.data.order.issuer_of_patient_id,'ISSUER_A');
   const duplicate=await api('/api/v1/ris/worklist-orders',{method:'POST',body:primary});
   assert.equal(duplicate.response.status,200);
   assert.equal(duplicate.data.created,false);
   const conflict=await api('/api/v1/ris/worklist-orders',{
     method:'POST',body:{...primary,patientName:'DIFFERENT^PATIENT'}});
   assert.equal(conflict.response.status,409);
   assert.equal((await api('/api/v1/ris/worklist-orders',{method:'POST',body:second})).response.status,201);
   const cancellable=await api('/api/v1/ris/worklist-orders',{method:'POST',body:cancelled});
   assert.equal(cancellable.response.status,201);
   const orderId=cancellable.data.order.id;
   const cancel=await api('/api/v1/ris/worklist-orders/'+orderId+'/status',{
     method:'PATCH',body:{status:'cancelled'}});
   assert.equal(cancel.response.status,200);
   const cannotUndo=await api('/api/v1/ris/worklist-orders/'+orderId+'/status',{
     method:'PATCH',body:{status:'scheduled'}});
   assert.equal(cannotUndo.response.status,409);
   const orders=await api('/api/v1/ris/worklist-orders?status=scheduled&stationAet=MWL_TEST_AE');
   assert.equal(orders.response.status,200);
   assert.ok(orders.data.some(o=>o.accession_number===primary.accessionNumber));
   assert.ok(orders.data.some(o=>o.accession_number===second.accessionNumber));
   assert.ok(!orders.data.some(o=>o.accession_number===cancelled.accessionNumber));

   process.env.PACS_MWL_EXPERIMENTAL='1';
   process.env.PACS_MWL_PORT='32193';
   process.env.PACS_MWL_AET='PACS_MWL';
   mwl=await startMwlScp();
   if(!mwl.server.server.listening)await once(mwl.server,'listening');

   async function query(keys) {
     const flags=[
       '-W','-v','-aet','MWL_TEST_AE','-aec','PACS_MWL',
       '-k','(0040,0100)[0].ScheduledStationAETitle=MWL_TEST_AE',
       ...keys.flatMap(x=>['-k',x]),
       '127.0.0.1','32193'
     ];
     const result=await execFile('findscu',flags,{timeout:12000,maxBuffer:2500000});
     return result.stdout+result.stderr;
   }
   const resultA=await query([
     'PatientID=MWLTEST123','IssuerOfPatientID=ISSUER_A',
     '(0040,0100)[0].Modality=CT',
     '(0040,0100)[0].ScheduledProcedureStepStartDate=20261116',
     'AccessionNumber','RequestedProcedureID'
   ]);
   assert.ok(resultA.includes(primary.accessionNumber),'MWL must return issuer A scheduled CT');
   assert.ok(!resultA.includes(second.accessionNumber),'different issuer must not silently match');
   assert.ok(!resultA.includes(cancelled.accessionNumber),'cancelled procedure must not appear');
   const resultB=await query([
     'PatientID=MWLTEST123','IssuerOfPatientID=ISSUER_B',
     '(0040,0100)[0].Modality=CT',
     'AccessionNumber'
   ]);
   assert.ok(resultB.includes(second.accessionNumber),'issuer B must independently match');
   assert.ok(!resultB.includes(primary.accessionNumber));
   const noMr=await query(['(0040,0100)[0].Modality=MR','AccessionNumber']);
   assert.ok(!noMr.includes(cancelled.accessionNumber));
 } finally {
   if(mwl)await mwl.close();
   delete process.env.PACS_MWL_EXPERIMENTAL;
   delete process.env.PACS_MWL_PORT;
   delete process.env.PACS_MWL_AET;
   server.kill('SIGTERM');
   await delay(250);
   if(server.exitCode===null)server.kill('SIGKILL');
 }
});
