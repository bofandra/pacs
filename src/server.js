import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { PacsCatalog } from './catalog.js';
import { element, validUID, withBulkDataUri } from './dicom.js';
import { parseDicomMultipart, buildDicomMultipart } from './multipart.js';
import { runDimse } from './dimse.js';
import { listRules,addRule,setRuleEnabled,enqueueManual,listJobs,retryJob } from './routing.js';

const conf=config();
if (!conf.token || conf.token.length<20) throw new Error('Set API_TOKEN (>=20 chars) before starting HTTP API');
const app=Fastify({logger:true,bodyLimit:conf.maxBytes,requestTimeout:30000});
const db=new PacsCatalog(conf);
const dicomType='application/dicom+json';
app.addContentTypeParser(/^multipart\/related/i,{parseAs:'buffer',bodyLimit:conf.maxBytes},(_req,body,done)=>done(null,body));
app.addHook('onRequest',async(req,reply)=>{
  if(req.url === '/health') return;
  const provided=req.headers.authorization?.replace(/^Bearer\s+/i,'') ?? '';
  const a=Buffer.from(provided),b=Buffer.from(conf.token);
  if (a.length!==b.length || !timingSafeEqual(a,b)) return reply.code(401).send({error:'Unauthorized'});
});
app.setErrorHandler((err,req,reply)=>reply.code(err.statusCode&&err.statusCode>=400&&err.statusCode<=599?err.statusCode:500).send({
  error:err.statusCode&&err.statusCode<500?err.message:'Internal error'
}));
app.get('/health',async()=>({status:'ok',component:'http',clinicalUse:false}));

function studyJson(s) {
  return {
    '0020000D':element('UI',s.study_uid),'00100020':element('LO',s.patient_id),
    '00100010':element('PN',s.patient_name),'00080050':element('SH',s.accession_number),
    '00080020':element('DA',s.study_date),'00081030':element('LO',s.study_description),
    '00201206':element('IS',s.series_count),'00201208':element('IS',s.instance_count)
  };
}
function seriesJson(s) {
  return {'0020000D':element('UI',s.study_uid),'0020000E':element('UI',s.series_uid),
    '00080060':element('CS',s.modality),'00200011':element('IS',s.series_number)};
}
function instanceJson(i) {
  return {...i.metadata,'00080018':element('UI',i.instance_uid),'00080016':element('UI',i.sop_class_uid)};
}
function onlyUIDs(...values) {
  if (!values.every(validUID)) throw Object.assign(new Error('Invalid DICOM UID in path'),{statusCode:400});
}

app.get('/dicomweb/studies',async(req,reply)=>{
  reply.type(dicomType);
  return (await db.studies(req.query)).map(studyJson);
});
app.get('/dicomweb/studies/:study/series',async(req,reply)=>{
  onlyUIDs(req.params.study); reply.type(dicomType);
  return (await db.series(req.params.study)).map(seriesJson);
});
app.get('/dicomweb/studies/:study/series/:series/instances',async(req,reply)=>{
  onlyUIDs(req.params.study,req.params.series); reply.type(dicomType);
  return (await db.instances(req.params.study,req.params.series)).map(instanceJson);
});
app.get('/dicomweb/studies/:study/metadata',async(req,reply)=>{
  onlyUIDs(req.params.study); reply.type(dicomType);
  const rows=await db.instances(req.params.study);
  return rows.map(i=>withBulkDataUri(i.metadata,'/dicomweb',i.study_uid,i.series_uid,i.instance_uid));
});
app.get('/dicomweb/studies/:study/series/:series/metadata',async(req,reply)=>{
  onlyUIDs(req.params.study,req.params.series); reply.type(dicomType);
  const rows=await db.instances(req.params.study,req.params.series);
  return rows.map(i=>withBulkDataUri(i.metadata,'/dicomweb',i.study_uid,i.series_uid,i.instance_uid));
});
app.get('/dicomweb/studies/:study/series/:series/instances/:instance/metadata',async(req,reply)=>{
  const {study,series,instance}=req.params;onlyUIDs(study,series,instance);
  const row=await db.instance(study,series,instance);
  if(!row) return reply.code(404).send({error:'Not found'});
  reply.type(dicomType);
  return [withBulkDataUri(row.metadata,'/dicomweb',study,series,instance)];
});
app.get('/dicomweb/studies/:study/series/:series/instances/:instance',async(req,reply)=>{
  const {study,series,instance}=req.params;onlyUIDs(study,series,instance);
  const row=await db.instance(study,series,instance);
  if(!row) return reply.code(404).send({error:'Not found'});
  const mime=buildDicomMultipart(await db.bytesFor(row),'pacs-'+randomBytes(12).toString('hex'));
  return reply.type(mime.type).send(mime.data);
});
app.post('/dicomweb/studies',async(req,reply)=>{
  if(!/^multipart\/related/i.test(req.headers['content-type']??''))
    return reply.code(415).send({error:'STOW-RS expects multipart/related with application/dicom parts'});
  const parts=parseDicomMultipart(req.headers['content-type'],req.body);
  if(parts.length===0) return reply.code(400).send({error:'No DICOM parts'});
  const success=[],failed=[];
  for(const p of parts) {
    try {
      const stored=await db.ingest(Buffer.from(p));
      success.push({'00081150':element('UI',stored.sopClassUID),'00081155':element('UI',stored.instanceUID)});
    } catch(error) {
      failed.push({'00081197':element('US',0x0110),'00081196':element('ST',error.message)});
    }
  }
  reply.type(dicomType).code(failed.length?202:200);
  return {'00081199':{vr:'SQ',Value:success},'00081198':{vr:'SQ',Value:failed}};
});
app.get('/api/v1/aes',async()=>db.nodes());
app.put('/api/v1/aes/:aet',async(req)=>db.upsertNode({...req.body,aet:req.params.aet}));
app.post('/api/v1/dimse/:operation',async(req)=>{
  const mode=req.params.operation;
  if(!['find','move','get'].includes(mode)) throw Object.assign(new Error('Unsupported DIMSE operation'),{statusCode:404});
  if(!req.body || typeof req.body.aet!=='string') throw Object.assign(new Error('aet and studyUID are required'),{statusCode:400});
  return runDimse(db,mode,req.body);
});
// P1 delivery rules are disabled until explicitly enabled by the operator.
app.get('/api/v1/routing/rules',async()=>listRules(db.pool));
app.post('/api/v1/routing/rules',async(req,reply)=>{
  const rule=await addRule(db.pool,req.body);
  return reply.code(201).send(rule);
});
app.patch('/api/v1/routing/rules/:id',async(req)=>{
  const value=Number(req.params.id);
  return setRuleEnabled(db.pool,value,req.body?.enabled);
});
app.get('/api/v1/delivery/jobs',async(req)=>listJobs(db.pool,req.query));
app.post('/api/v1/delivery/jobs',async(req,reply)=>{
  const job=await enqueueManual(db.pool,req.body??{});
  return reply.code(202).send(job);
});
app.post('/api/v1/delivery/jobs/:id/retry',async(req)=>{
  return retryJob(db.pool,Number(req.params.id));
});
app.get('/api/v1/delivery/stats',async()=>{
  return (await db.pool.query('SELECT status,count(*)::int AS count FROM delivery_jobs GROUP BY status ORDER BY status')).rows;
});
app.get('/api/v1/audit',async(req)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||50,1),100);
  return (await db.pool.query('SELECT id,event_type,reference_uid,details,created_at FROM audit_events ORDER BY id DESC LIMIT $1',[limit])).rows;
});
async function exit(){await app.close();await db.close();}
process.once('SIGINT',()=>exit().finally(()=>process.exit()));
process.once('SIGTERM',()=>exit().finally(()=>process.exit()));
await app.listen({host:conf.host,port:conf.port});
