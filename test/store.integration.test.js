import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startStoreScp } from '../src/store-scp.js';
import { parseDicom } from '../src/dicom.js';

const execFile=promisify(execFileCallback);
const enabled=process.env.PACS_INTEGRATION==='1'&&process.env.PACS_DCMTK==='1';
const token='test-only-strong-token-not-for-clinical-use';
const base='http://127.0.0.1:32196';
const auth={Authorization:'Bearer '+token};
const uid=()=> '2.25.'+BigInt('0x'+crypto.randomBytes(16).toString('hex')).toString(10);
function attr(g,e,vr,v) {
  const long=['OB','OW','SQ','UN','UT'].includes(vr);
  let bytes=Buffer.isBuffer(v)?Buffer.from(v):Buffer.from(String(v),'ascii');
  if(bytes.length%2) bytes=Buffer.concat([bytes,Buffer.from([vr==='UI'?0:32])]);
  const head=Buffer.alloc(long?12:8);head.writeUInt16LE(g,0);head.writeUInt16LE(e,2);
  head.write(vr,4,'ascii');if(long)head.writeUInt32LE(bytes.length,8);
  else head.writeUInt16LE(bytes.length,6);
  return Buffer.concat([head,bytes]);
}
const short=v=>{const b=Buffer.alloc(2);b.writeUInt16LE(v);return b;};
function synthetic(ids,patientName='TEST^SYNTHETIC') {
 const sopClass='1.2.840.10008.5.1.4.1.1.1';
 const meta=Buffer.concat([
   attr(2,1,'OB',Buffer.from([0,1])),
   attr(2,2,'UI',sopClass),attr(2,3,'UI',ids.instance),
   attr(2,0x10,'UI','1.2.840.10008.1.2.1'),
   attr(2,0x12,'UI','2.25.1')
 ]);
 const size=Buffer.alloc(4);size.writeUInt32LE(meta.length);
 return Buffer.concat([
   Buffer.alloc(128),Buffer.from('DICM'),attr(2,0,'UL',size),meta,
   attr(8,0x16,'UI',sopClass),attr(8,0x18,'UI',ids.instance),
   attr(8,0x20,'DA','20261115'),attr(8,0x60,'CS','CR'),
   attr(0x10,0x10,'PN',patientName),attr(0x10,0x20,'LO','SYNTHETIC-DIMSE-001'),
   attr(0x20,0x0d,'UI',ids.study),attr(0x20,0x0e,'UI',ids.series),
   attr(0x28,2,'US',short(1)),attr(0x28,4,'CS','MONOCHROME2'),
   attr(0x28,0x10,'US',short(1)),attr(0x28,0x11,'US',short(1)),
   attr(0x28,0x100,'US',short(16)),attr(0x28,0x101,'US',short(16)),
   attr(0x28,0x102,'US',short(15)),attr(0x28,0x103,'US',short(0)),
   attr(0x7fe0,0x10,'OW',short(175))
 ]);
}
test('independent DCMTK echoscu/storescu to native Node.js SCP and QIDO/WADO',
 {skip:!enabled,timeout:45000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pacs-store-ci-'));
 const ids={study:uid(),series:uid(),instance:uid()};
 const sample=path.join(root,'synthetic-cr.dcm');
 const collision=path.join(root,'collision-cr.dcm');
 await fs.writeFile(sample,synthetic(ids));
 await fs.writeFile(collision,synthetic(ids,'DIFFERENT^PATIENT'));
 const server=spawn(process.execPath,['src/server.js'],{
   cwd:process.cwd(),env:{...process.env,HTTP_HOST:'127.0.0.1',HTTP_PORT:'32196',API_TOKEN:token},
   stdio:'ignore'
 });
 let scp;
 try {
   let ready=false;
   for(let i=0;i<70;i++){
     if(server.exitCode!==null)throw Error('PACS HTTP server exited');
     try{const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}
     await delay(120);
   }
   assert.equal(ready,true,'HTTP API must start');
   const registered=await fetch(base+'/api/v1/aes/SIMULATOR',{
     method:'PUT',headers:{...auth,'Content-Type':'application/json'},
     body:JSON.stringify({host:'127.0.0.1',port:11114,enabled:true})
   });
   assert.equal(registered.status,200);
   process.env.PACS_STORE_EXPERIMENTAL='1';
   process.env.PACS_STORE_PORT='32195';
   scp=await startStoreScp();
   if(!scp.server.server.listening)await once(scp.server,'listening');
   const echo=await execFile('echoscu',[
     '-v','-aet','SIMULATOR','-aec','PACS_NATIVE','127.0.0.1','32195'
   ],{timeout:12000,maxBuffer:1500000});
   assert.match(echo.stdout+echo.stderr,/Success|successful|0x0000/i);
   const store=()=>execFile('storescu',[
     '-v','-aet','SIMULATOR','-aec','PACS_NATIVE',
     '127.0.0.1','32195',sample
   ],{timeout:12000,maxBuffer:1500000});
   const transfer=await store();
   assert.match(transfer.stdout+transfer.stderr,/Success|0x0000/i);
   const studies=await fetch(base+'/dicomweb/studies?StudyInstanceUID='+ids.study,{headers:auth});
   assert.equal(studies.status,200);
   const found=await studies.json();
   assert.equal(found.length,1,'C-STORE must index the study BEFORE success');
   assert.equal(found[0]['0020000D'].Value[0],ids.study);
   const retrieved=await fetch(
     base+'/dicomweb/studies/'+ids.study+'/series/'+ids.series+'/instances/'+ids.instance,
     {headers:auth});
   assert.equal(retrieved.status,200);
   const bytes=Buffer.from(await retrieved.arrayBuffer());
   const start=bytes.indexOf(Buffer.from('DICM'));
   assert.ok(start>=128,'WADO multipart response must contain Part 10 DICOM');
   const part10=bytes.subarray(start-128,bytes.lastIndexOf(Buffer.from('\r\n--')));
   const parsed=parseDicom(part10);
   assert.equal(parsed.studyUID,ids.study);
   assert.equal(parsed.seriesUID,ids.series);
   assert.equal(parsed.instanceUID,ids.instance);
   // Repeated identical DIMSE payload must not introduce another instance.
   await store();
   const instances=await scp.catalog.pool.query(
     'SELECT instance_uid,sha256 FROM instances WHERE instance_uid=$1',[ids.instance]);
   assert.equal(instances.rowCount,1);
   const conflict=await execFile('storescu',[
     '-v','-aet','SIMULATOR','-aec','PACS_NATIVE',
     '127.0.0.1','32195',collision
   ],{timeout:12000,maxBuffer:1500000}).catch(error=>({
     stdout:error.stdout??'',stderr:error.stderr??''
   }));
   assert.doesNotMatch(conflict.stdout+conflict.stderr,/C-STORE RSP.*status: Success/i,
     'Same SOP Instance UID with changed content must not be accepted as success');
   await assert.rejects(execFile('echoscu',[
     '-aet','UNREGISTERED','-aec','PACS_NATIVE','127.0.0.1','32195'
   ],{timeout:10000,maxBuffer:1500000}),/rejected|failed|aborted|exit/i);
 }finally{
   if(scp)await scp.close();
   delete process.env.PACS_STORE_EXPERIMENTAL;
   delete process.env.PACS_STORE_PORT;
   server.kill('SIGTERM');
   await delay(250);
   if(server.exitCode===null)server.kill('SIGKILL');
   await fs.rm(root,{recursive:true,force:true});
 }
});
