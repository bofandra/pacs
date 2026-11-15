import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { PacsCatalog } from '../src/catalog.js';
import { processDeliveryJob } from '../src/delivery-worker.js';
import { once } from 'node:events';
import dimsePackage from 'dcmjs-dimse';
import { startFindScp } from '../src/find-scp.js';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {buildDicomMultipart} from '../src/multipart.js';
import {parseDicom} from '../src/dicom.js';

const enabled=process.env.PACS_INTEGRATION === '1';
const uid = () => '2.25.' + BigInt('0x'+crypto.randomBytes(16).toString('hex')).toString(10);
function attr(group,element,vr,value){
  const long=['OB','OW','SQ','UN','UT'].includes(vr);
  let bytes=Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(String(value),'ascii');
  if(bytes.length%2) bytes=Buffer.concat([bytes,Buffer.from([vr==='UI'?0:32])]);
  const header=Buffer.alloc(long?12:8);
  header.writeUInt16LE(group,0);header.writeUInt16LE(element,2);header.write(vr,4,'ascii');
  if(long) header.writeUInt32LE(bytes.length,8);
  else header.writeUInt16LE(bytes.length,6);
  return Buffer.concat([header,bytes]);
}
function u16(value){const b=Buffer.alloc(2);b.writeUInt16LE(value);return b;}
function makeSyntheticDicom(ids){
  const sopClass='1.2.840.10008.5.1.4.1.1.1'; // CR Image Storage
  const meta=Buffer.concat([
    attr(0x0002,0x0001,'OB',Buffer.from([0,1])),
    attr(0x0002,0x0002,'UI',sopClass),
    attr(0x0002,0x0003,'UI',ids.instance),
    attr(0x0002,0x0010,'UI','1.2.840.10008.1.2.1'),
    attr(0x0002,0x0012,'UI','2.25.1')
  ]);
  const len=Buffer.alloc(4);len.writeUInt32LE(meta.length);
  return Buffer.concat([
    Buffer.alloc(128),Buffer.from('DICM'),
    attr(0x0002,0x0000,'UL',len),meta,
    attr(0x0008,0x0016,'UI',sopClass),
    attr(0x0008,0x0018,'UI',ids.instance),
    attr(0x0008,0x0020,'DA','20261115'),
    attr(0x0008,0x0060,'CS','CR'),
    attr(0x0010,0x0010,'PN',ids.name??'TEST^SYNTHETIC'),
    attr(0x0010,0x0020,'LO','SYNTHETIC-001'),
    attr(0x0020,0x000D,'UI',ids.study),
    attr(0x0020,0x000E,'UI',ids.series),
    attr(0x0028,0x0002,'US',u16(1)),
    attr(0x0028,0x0004,'CS','MONOCHROME2'),
    attr(0x0028,0x0010,'US',u16(1)),
    attr(0x0028,0x0011,'US',u16(1)),
    attr(0x0028,0x0100,'US',u16(16)),
    attr(0x0028,0x0101,'US',u16(16)),
    attr(0x0028,0x0102,'US',u16(15)),
    attr(0x0028,0x0103,'US',u16(0)),
    attr(0x7fe0,0x0010,'OW',u16(100))
  ]);
}
test('synthetic Part 10 DICOM parsing',()=>{
  const ids={study:uid(),series:uid(),instance:uid()};
  const parsed=parseDicom(makeSyntheticDicom(ids));
  assert.equal(parsed.studyUID,ids.study);
  assert.equal(parsed.instanceUID,ids.instance);
  assert.equal(parsed.patientId,'SYNTHETIC-001');
});

test('PostgreSQL + STOW/QIDO/WADO roundtrip and duplicate safety',{skip:!enabled,timeout:45000},async()=>{
  const ids={study:uid(),series:uid(),instance:uid()};
  const original=makeSyntheticDicom(ids);
  const port=32189;
  const token='test-only-strong-token-not-for-clinical-use';
  const server=spawn(process.execPath,['src/server.js'],{
    cwd:process.cwd(),env:{...process.env,HTTP_HOST:'127.0.0.1',HTTP_PORT:String(port),API_TOKEN:token},
    stdio:'ignore'
  });
  const base='http://127.0.0.1:'+port;
  const auth={Authorization:'Bearer '+token};
  async function request(path,options={}) {
    return fetch(base+path,{...options,headers:{...auth,...options.headers}});
  }
  try {
    let ready=false;
    for(let i=0;i<60;i++){
      if(server.exitCode!==null) throw Error('PACS HTTP server exited unexpectedly');
      try {const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}
      await delay(150);
    }
    assert.equal(ready,true,'PACS server did not become ready');
    const part=buildDicomMultipart(original,'synthetic-boundary');
    const store=()=>request('/dicomweb/studies',{method:'POST',headers:{'Content-Type':part.type},body:part.data});
    const stow=await store(); assert.equal(stow.status,200);
    assert.equal((await stow.json())['00081199'].Value.length,1);
    const studies=await request('/dicomweb/studies?StudyInstanceUID='+ids.study);
    const found=await studies.json();
    assert.equal(found.length,1);assert.equal(found[0]['0020000D'].Value[0],ids.study);
    const series=await request('/dicomweb/studies/'+ids.study+'/series');
    assert.equal((await series.json()).length,1);
    const instances=await request('/dicomweb/studies/'+ids.study+'/series/'+ids.series+'/instances');
    assert.equal((await instances.json()).length,1);
    const retrieve=await request('/dicomweb/studies/'+ids.study+'/series/'+ids.series+'/instances/'+ids.instance);
    assert.equal(retrieve.status,200);
    const wado=Buffer.from(await retrieve.arrayBuffer());
    assert.notEqual(wado.indexOf(original),-1,'WADO response must preserve original bytes');
    assert.equal((await store()).status,200,'identical SOP UID and digest are idempotent');
    const colliding=buildDicomMultipart(makeSyntheticDicom({...ids,name:'DIFFERENT^PATIENT'}),'collision-boundary');
    const conflict=await request('/dicomweb/studies',{method:'POST',headers:{'Content-Type':colliding.type},body:colliding.data});
    assert.equal(conflict.status,202);
    assert.equal((await conflict.json())['00081198'].Value.length,1);
    const ae=await request('/api/v1/aes/SIMULATOR',{method:'PUT',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({host:'127.0.0.1',port:11114,enabled:true})});
    assert.equal(ae.status,200);
    const nodes=await (await request('/api/v1/aes')).json();
    assert.ok(nodes.some(x=>x.aet==='SIMULATOR'));
    // Route creation is deliberately disabled by default.
    const routeCreate=await request('/api/v1/routing/rules',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({destinationAet:'SIMULATOR',modality:'CR'})});
    assert.equal(routeCreate.status,201);
    const rule=await routeCreate.json();
    assert.equal(rule.enabled,false);
    const ruleEnable=await request('/api/v1/routing/rules/'+rule.id,{
      method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});
    assert.equal(ruleEnable.status,200);
    assert.equal((await ruleEnable.json()).enabled,true);
    const catalog=new PacsCatalog(config());
    try {
      const routed={study:uid(),series:uid(),instance:uid()};
      const routedBytes=makeSyntheticDicom(routed);
      const routedPart=buildDicomMultipart(routedBytes,'routed-test-boundary');
      const ingestRouted=()=>request('/dicomweb/studies',{
        method:'POST',headers:{'Content-Type':routedPart.type},body:routedPart.data});
      assert.equal((await ingestRouted()).status,200);
      const queued=await (await request('/api/v1/delivery/jobs?status=queued')).json();
      assert.ok(queued.some(job=>job.instance_uid===routed.instance&&job.destination_aet==='SIMULATOR'));
      const completed=await processDeliveryJob(catalog,async ({sourcePath,node})=>{
        assert.equal(node.aet,'SIMULATOR');
        assert.deepEqual(await fs.readFile(path.join(sourcePath,'instance.dcm')),routedBytes);
      });
      assert.equal(completed.status,'succeeded');
      const oldJob=(await (await request('/api/v1/delivery/jobs')).json())
        .find(job=>job.instance_uid===routed.instance);
      assert.equal(oldJob.status,'succeeded');
      assert.equal((await ingestRouted()).status,200);
      const afterDuplicate=(await (await request('/api/v1/delivery/jobs')).json())
        .filter(job=>job.instance_uid===routed.instance);
      assert.equal(afterDuplicate.length,1,'duplicated DICOM must not enqueue another delivery');

      // Failure causes persistent retry; simulate the backoff expiring in CI.
      const needsRetry={study:uid(),series:uid(),instance:uid()};
      const retryPart=buildDicomMultipart(makeSyntheticDicom(needsRetry),'retry-boundary');
      assert.equal((await request('/dicomweb/studies',{
        method:'POST',headers:{'Content-Type':retryPart.type},body:retryPart.data})).status,200);
      const failed=await processDeliveryJob(catalog,async ()=>{
        throw Object.assign(new Error('synthetic network failure'),{code:'DIMSE_ASSOCIATION_FAILED'});
      });
      assert.equal(failed.status,'queued');
      const waitJob=(await (await request('/api/v1/delivery/jobs')).json())
        .find(job=>job.instance_uid===needsRetry.instance);
      assert.equal(waitJob.error_code,'DIMSE_ASSOCIATION_FAILED');
      assert.equal(waitJob.attempts,1);
      assert.ok(new Date(waitJob.next_attempt_at).getTime()>Date.now()-1000);
      await catalog.pool.query('UPDATE delivery_jobs SET next_attempt_at=now() WHERE id=$1',[waitJob.id]);
      const retried=await processDeliveryJob(catalog,async()=>{});
      assert.equal(retried.status,'succeeded');
      const succeeded=(await (await request('/api/v1/delivery/jobs')).json())
        .find(job=>job.instance_uid===needsRetry.instance);
      assert.equal(succeeded.attempts,2);

      const dead={study:uid(),series:uid(),instance:uid()};
      const deadPart=buildDicomMultipart(makeSyntheticDicom(dead),'dead-letter-boundary');
      assert.equal((await request('/dicomweb/studies',{
        method:'POST',headers:{'Content-Type':deadPart.type},body:deadPart.data})).status,200);
      const deadJob=(await (await request('/api/v1/delivery/jobs')).json())
        .find(job=>job.instance_uid===dead.instance);
      await catalog.pool.query('UPDATE delivery_jobs SET max_attempts=1 WHERE id=$1',[deadJob.id]);
      assert.equal((await processDeliveryJob(catalog,async()=>{throw new Error('simulated failure')})).status,'dead_letter');
      const revived=await request('/api/v1/delivery/jobs/'+deadJob.id+'/retry',{method:'POST'});
      assert.equal(revived.status,200);
      assert.equal((await revived.json()).status,'queued');
      assert.equal((await processDeliveryJob(catalog,async()=>{})).status,'succeeded');
      const stats=await (await request('/api/v1/delivery/stats')).json();
      assert.ok(stats.some(x=>x.status==='succeeded'&&x.count>=3));

      const ruleDisable=await request('/api/v1/routing/rules/'+rule.id,{
        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});
      assert.equal(ruleDisable.status,200);

      // Disabled rules create no automatic jobs; manual enqueue is explicit and idempotent.
      const noRoute={study:uid(),series:uid(),instance:uid()};
      const noRoutePart=buildDicomMultipart(makeSyntheticDicom(noRoute),'disabled-rule-boundary');
      const nr=await request('/dicomweb/studies',{
        method:'POST',headers:{'Content-Type':noRoutePart.type},body:noRoutePart.data});
      assert.equal(nr.status,200);
      const neverAuto=(await (await request('/api/v1/delivery/jobs')).json())
        .filter(job=>job.instance_uid===noRoute.instance);
      assert.equal(neverAuto.length,0);
      const enqueueBody={instanceUID:noRoute.instance,destinationAet:'SIMULATOR'};
      const sendManual=()=>request('/api/v1/delivery/jobs',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(enqueueBody)});
      const firstManual=await sendManual();
      assert.equal(firstManual.status,202);
      const firstJob=await firstManual.json();
      const secondManual=await sendManual();
      assert.equal((await secondManual.json()).id,firstJob.id);
      const disableAe=await request('/api/v1/aes/SIMULATOR',{method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({host:'127.0.0.1',port:11114,enabled:false})});
      assert.equal(disableAe.status,200);
      assert.equal(await processDeliveryJob(catalog,async()=>{throw Error('must never send')}),null);
      const enableAe=await request('/api/v1/aes/SIMULATOR',{method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({host:'127.0.0.1',port:11114,enabled:true})});
      assert.equal(enableAe.status,200);
      assert.equal((await processDeliveryJob(catalog,async()=>{})).status,'succeeded');
    } finally {await catalog.close();}
    // Real DIMSE association and C-FIND against the same PostgreSQL catalog.
    // This is a synthetic-data library client test, not yet independent DCMTK certification.
    process.env.PACS_FIND_EXPERIMENTAL='1';
    process.env.PACS_FIND_PORT='32190';
    const findService=await startFindScp();
    try {
      if(!findService.server.server.listening) await once(findService.server,'listening');
      const { Client, requests, constants }=dimsePackage;
      const findOverWire=(kind,keys,callingAet='SIMULATOR')=>new Promise((resolve,reject)=>{
        let complete=false;
        const matches=[];
        const client=new Client();
        const ctor=kind==='STUDY'?'createStudyFindRequest':kind==='SERIES'
          ?'createSeriesFindRequest':'createImageFindRequest';
        const rq=requests.CFindRequest[ctor](keys);
        const timeout=setTimeout(()=>finish(new Error('C-FIND SCP timed out')),9000);
        function finish(error,value) {
          if(complete) return;
          complete=true;clearTimeout(timeout);
          if(error) reject(error);else resolve(value);
        }
        rq.on('response',response=>{
          const code=response.getStatus();
          if(code===constants.Status.Pending && response.hasDataset())
            matches.push(response.getDataset().getElements());
          else if(code===constants.Status.Success) finish(null,matches);
          else if(code!==constants.Status.Pending)
            finish(new Error('C-FIND failed with status '+code));
        });
        client.on('networkError',()=>finish(new Error('DIMSE network error')));
        client.on('associationRejected',()=>finish(new Error('DIMSE association rejected')));
        client.on('closed',()=>{if(!complete) finish(new Error('Association closed before completion'));});
        client.addRequest(rq);
        client.send('127.0.0.1',32190,callingAet,'PACS_NATIVE');
      });
      const foundStudy=await findOverWire('STUDY',{StudyInstanceUID:ids.study});
      assert.equal(foundStudy.length,1);
      assert.equal(foundStudy[0].StudyInstanceUID,ids.study);
      assert.equal(foundStudy[0].PatientID,'SYNTHETIC-001');
      const foundSeries=await findOverWire('SERIES',{StudyInstanceUID:ids.study});
      assert.equal(foundSeries.length,1);
      assert.equal(foundSeries[0].SeriesInstanceUID,ids.series);
      const foundImage=await findOverWire('IMAGE',{StudyInstanceUID:ids.study,SeriesInstanceUID:ids.series});
      assert.equal(foundImage.length,1);
      assert.equal(foundImage[0].SOPInstanceUID,ids.instance);
      await assert.rejects(
        findOverWire('STUDY',{StudyInstanceUID:ids.study},'UNKNOWN_AET'),
        /rejected|closed|network/i
      );
    } finally {
      await findService.close();
      delete process.env.PACS_FIND_EXPERIMENTAL;
      delete process.env.PACS_FIND_PORT;
    }
    assert.equal((await fetch(base+'/dicomweb/studies')).status,401);
  } finally {
    server.kill('SIGTERM');
    await delay(300);
    if(server.exitCode===null) server.kill('SIGKILL');
  }
});
