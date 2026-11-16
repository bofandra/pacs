import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {startMwlScp} from '../src/mwl-scp.js';
import {buildDicomMultipart} from '../src/multipart.js';

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
// Synthetic Part 10 only. Study/Patient/Accession fields mirror a RIS worklist order.
function field(group,element,vr,value) {
  const long=['OB','OW','SQ','UN','UT'].includes(vr);
  let data=Buffer.isBuffer(value)?value:Buffer.from(String(value),'ascii');
  if(data.length%2)data=Buffer.concat([data,Buffer.from([vr==='UI'?0:32])]);
  const header=Buffer.alloc(long?12:8);
  header.writeUInt16LE(group,0);header.writeUInt16LE(element,2);header.write(vr,4,'ascii');
  if(long)header.writeUInt32LE(data.length,8);
  else header.writeUInt16LE(data.length,6);
  return Buffer.concat([header,data]);
}
function syntheticStudy(order,instanceSuffix,issuer=order.issuerOfPatientId,accessionIssuer=order.accessionIssuer) {
  const sopClass='1.2.840.10008.5.1.4.1.1.2';
  const sopInstance='2.25.654321'+instanceSuffix;
  const series='2.25.789321'+instanceSuffix;
  const meta=Buffer.concat([
    field(2,1,'OB',Buffer.from([0,1])),
    field(2,2,'UI',sopClass),field(2,3,'UI',sopInstance),
    field(2,0x10,'UI','1.2.840.10008.1.2.1'),field(2,0x12,'UI','2.25.1')
  ]);
  const length=Buffer.alloc(4);length.writeUInt32LE(meta.length);
  let accessionAuthority=Buffer.alloc(0);
  if(accessionIssuer){
    const authority=field(0x40,0x0031,'UT',accessionIssuer);
    const item=Buffer.alloc(8);
    item.writeUInt16LE(0xfffe,0);item.writeUInt16LE(0xe000,2);
    item.writeUInt32LE(authority.length,4);
    accessionAuthority=field(8,0x51,'SQ',Buffer.concat([item,authority]));
  }
  return Buffer.concat([
    Buffer.alloc(128),Buffer.from('DICM'),
    field(2,0,'UL',length),meta,
    field(8,0x16,'UI',sopClass),field(8,0x18,'UI',sopInstance),
    field(8,0x20,'DA',order.scheduledStartDate),
    field(8,0x50,'SH',order.accessionNumber),
    accessionAuthority,
    field(8,0x60,'CS',order.modality),
    field(0x10,0x10,'PN',order.patientName),
    field(0x10,0x20,'LO',order.patientId),
    field(0x10,0x21,'LO',issuer),
    field(0x20,0x0d,'UI',order.studyInstanceUID),
    field(0x20,0x0e,'UI',series),
    field(0x7fe0,0x10,'OW',Buffer.from([0,0]))
  ]);
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

   const nextMorning={
     ...syntheticOrder(104,'ISSUER_A'),
     scheduledStartDate:'20261117',
     scheduledStartTime:'010000'
   };
   const afterRange={
     ...syntheticOrder(105,'ISSUER_A'),
     scheduledStartDate:'20261117',
     scheduledStartTime:'040000'
   };
   for(const order of [nextMorning,afterRange])
     assert.equal((await api('/api/v1/ris/worklist-orders',{method:'POST',body:order})).response.status,201);
   const overnight=await query([
     'IssuerOfPatientID=ISSUER_A','AccessionNumber',
     '(0040,0100)[0].ScheduledProcedureStepStartDate=20261116-20261117',
     '(0040,0100)[0].ScheduledProcedureStepStartTime=100000-020000'
   ]);
   assert.ok(overnight.includes(primary.accessionNumber));
   assert.ok(overnight.includes(nextMorning.accessionNumber));
   assert.ok(!overnight.includes(afterRange.accessionNumber));

   // RIS order -> worklist -> synthetic DICOM ingest -> explicit reconciliation.
   const before=(await api('/api/v1/ris/worklist-orders/'+created.data.order.id+'/reconciliation')).data;
   assert.equal(before.status,'not_received');
   async function stow(bytes,boundary){
     const multipart=buildDicomMultipart(bytes,boundary);
     const res=await fetch(base+'/dicomweb/studies',{
       method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':multipart.type},
       body:multipart.data
     });
     return res.status;
   }
   assert.equal(await stow(syntheticStudy(primary,101),'mwl-image-101'),200);
   const reconciled=(await api('/api/v1/ris/worklist-orders/'+created.data.order.id+'/reconciliation')).data;
   assert.equal(reconciled.status,'identity_consistent');
   assert.equal(reconciled.issuerOfPatientIdMatches,true);
   assert.equal(reconciled.accessionIssuerVerified,true);
   assert.equal(reconciled.automaticPatientMerge,false);

   // Same PatientID but WRONG issuer must remain an explicit mismatch.
   assert.equal(await stow(syntheticStudy(second,102,'ISSUER_A'),'mwl-image-102'),200);
   const secondId=(await api('/api/v1/ris/worklist-orders?stationAet=MWL_TEST_AE')).data
     .find(x=>x.accession_number===second.accessionNumber).id;
   const mismatch=(await api('/api/v1/ris/worklist-orders/'+secondId+'/reconciliation')).data;
   assert.equal(mismatch.status,'mismatch');
   assert.equal(mismatch.patientIdMatches,true);
   assert.equal(mismatch.issuerOfPatientIdMatches,false);

   const scheduled=(await api('/api/v1/ris/worklist-orders?stationAet=MWL_TEST_AE')).data;
   const reconcile=async order=>{
     const {id}=scheduled.find(row=>row.accession_number===order.accessionNumber);
     return (await api('/api/v1/ris/worklist-orders/'+id+'/reconciliation')).data;
   };
   assert.equal(await stow(syntheticStudy(nextMorning,104,'ISSUER_A','ISSUER_B'),'mwl-image-104'),200);
   const wrongAccessionIssuer=await reconcile(nextMorning);
   assert.equal(wrongAccessionIssuer.status,'mismatch');
   assert.equal(wrongAccessionIssuer.issuerOfPatientIdMatches,true);
   assert.equal(wrongAccessionIssuer.accessionIssuerMatches,false);
   assert.equal(await stow(syntheticStudy(afterRange,105,'ISSUER_A',null),'mwl-image-105'),200);
   const missingAccessionIssuer=await reconcile(afterRange);
   assert.equal(missingAccessionIssuer.accessionIssuerMatches,null);
   assert.equal(missingAccessionIssuer.accessionIssuerVerified,false);
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
