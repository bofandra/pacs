import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {buildDicomMultipart} from '../src/multipart.js';
import {parseDicom} from '../src/dicom.js';
import dicomParser from 'dicom-parser';

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
  const raw=makeSyntheticDicom(ids);
  const ds=dicomParser.parseDicom(new Uint8Array(raw),{untilTag:'x7fe00010'});
  const uidTags=['x0020000d','x0020000e','x00080018','x00080016'];
  console.log('SYNTHETIC UID PROBE',uidTags.map(tag=>({tag,value:ds.string(tag),length:ds.elements[tag]?.length})));
  const parsed=parseDicom(raw);
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
    assert.equal((await fetch(base+'/dicomweb/studies')).status,401);
  } finally {
    server.kill('SIGTERM');
    await delay(300);
    if(server.exitCode===null) server.kill('SIGKILL');
  }
});
