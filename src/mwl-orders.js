import crypto from 'node:crypto';
import {validDicomDate,validUID} from './dicom.js';

export class WorklistOrderError extends Error {
  constructor(message,statusCode=400) {super(message);this.statusCode=statusCode;}
}
const fail=(message,code=400)=>{throw new WorklistOrderError(message,code);};
const required={
  sourceSystem:48,externalOrderId:96,accessionIssuer:48,accessionNumber:16,
  patientId:64,issuerOfPatientId:64,patientName:192,studyInstanceUID:64,
  requestedProcedureId:64,requestedProcedureDescription:128,
  scheduledProcedureStepId:64,scheduledProcedureStepDescription:128,
  scheduledStationAETitle:16,modality:8,scheduledStartDate:8,
  scheduledStartTime:6,scheduleTimezone:64
};
const optional={patientBirthDate:8,patientSex:1};
const allowedFields=new Set([...Object.keys(required),...Object.keys(optional)]);
function timeValid(s){return /^\d{6}$/.test(s)&&Number(s.slice(0,2))<24
  &&Number(s.slice(2,4))<60&&Number(s.slice(4,6))<60;}
export function normalizeWorklistOrder(input) {
  if(!input || typeof input!=='object' || Array.isArray(input))fail('Order must be an object');
  for(const k of Object.keys(input))if(!allowedFields.has(k))fail('Unknown order field: '+k);
  const normalized={};
  for(const [key,max] of Object.entries(required)) {
    const value=input[key];
    if(typeof value!=='string'||!value.trim()||value.trim().length>max
       ||/[\u0000-\u001f\u007f]/.test(value)) fail('Invalid required field: '+key);
    normalized[key]=value.trim();
  }
  for(const [key,max] of Object.entries(optional)){
    const value=input[key]??null;
    if(value!==null&&(typeof value!=='string'||value.length>max
      ||/[\u0000-\u001f\u007f]/.test(value)))fail('Invalid optional field: '+key);
    normalized[key]=value===null||value===''?null:value.trim();
  }
  if(!validUID(normalized.studyInstanceUID))fail('Invalid StudyInstanceUID');
  if(!/^[A-Z0-9_-]{1,16}$/.test(normalized.scheduledStationAETitle))
    fail('Invalid Scheduled Station AE Title');
  if(!/^[A-Z0-9]{1,8}$/.test(normalized.modality))
    fail('Invalid Modality');
  if(!validDicomDate(normalized.scheduledStartDate))fail('Invalid scheduled date');
  if(!timeValid(normalized.scheduledStartTime))fail('Invalid scheduled time');
  if(normalized.patientBirthDate&&!validDicomDate(normalized.patientBirthDate))
    fail('Invalid patient birth date');
  if(normalized.patientSex&&!['M','F','O'].includes(normalized.patientSex))
    fail('Invalid patient sex');
  if(!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(normalized.scheduleTimezone))
    fail('Invalid timezone');
  try {new Intl.DateTimeFormat('en-US',{timeZone:normalized.scheduleTimezone});}
  catch{fail('Unknown scheduleTimezone');}
  if(!/^[A-Za-z0-9_/-]{1,48}$/.test(normalized.sourceSystem))
    fail('Invalid sourceSystem');
  // No silent PatientID/AccessionNumber coalescing: issuers are mandatory.
  return normalized;
}
export function fingerprintOrder(normalized){
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
const orderColumns=[
  'source_system','external_order_id','accession_issuer','accession_number',
  'patient_id','issuer_of_patient_id','patient_name','patient_birth_date','patient_sex',
  'study_instance_uid','requested_procedure_id','requested_procedure_description',
  'scheduled_procedure_step_id','scheduled_procedure_step_description',
  'scheduled_station_aet','modality','scheduled_start_date','scheduled_start_time',
  'schedule_timezone'
];
export async function createWorklistOrder(pool,input) {
  const o=normalizeWorklistOrder(input);
  const digest=fingerprintOrder(o);
  const values=[
    o.sourceSystem,o.externalOrderId,o.accessionIssuer,o.accessionNumber,
    o.patientId,o.issuerOfPatientId,o.patientName,o.patientBirthDate,o.patientSex,
    o.studyInstanceUID,o.requestedProcedureId,o.requestedProcedureDescription,
    o.scheduledProcedureStepId,o.scheduledProcedureStepDescription,
    o.scheduledStationAETitle,o.modality,o.scheduledStartDate,o.scheduledStartTime,
    o.scheduleTimezone
  ];
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const peer=await client.query('SELECT enabled FROM ae_nodes WHERE aet=$1',
      [o.scheduledStationAETitle]);
    if(!peer.rows[0]?.enabled)fail('Station AE must be registered and enabled',409);
    const fields=[...orderColumns,'payload_sha256'];
    const args=[...values,digest];
    const query=`INSERT INTO ris_worklist_orders(${fields.join(',')})
      VALUES(${args.map((_,i)=>'$'+(i+1)).join(',')})
      ON CONFLICT(source_system,external_order_id) DO NOTHING RETURNING *`;
    const inserted=await client.query(query,args);
    let row=inserted.rows[0];
    if(!row) {
      const existing=await client.query(
        'SELECT * FROM ris_worklist_orders WHERE source_system=$1 AND external_order_id=$2',
        [o.sourceSystem,o.externalOrderId]);
      row=existing.rows[0];
      if(!row || row.payload_sha256!==digest)
        fail('Order reference reused with different patient/procedure/schedule data',409);
    } else {
      await client.query('INSERT INTO audit_events(event_type,reference_uid,details) VALUES($1,$2,$3)',
        ['mwl_order_created',o.studyInstanceUID,JSON.stringify({
          stationAet:o.scheduledStationAETitle,sourceSystem:o.sourceSystem
        })]);
    }
    await client.query('COMMIT');
    return {created:inserted.rowCount===1,order:row};
  }catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    if(err.code==='23505')fail('Conflicting accession or scheduled step identity',409);
    throw err;
  }finally{client.release();}
}
export async function listWorklistOrders(pool,{status,stationAet,limit=30}={}) {
  if(status!==undefined&&!['scheduled','on_hold','completed','cancelled'].includes(status))
    fail('Invalid worklist status');
  if(stationAet!==undefined&&!/^[A-Z0-9_-]{1,16}$/.test(stationAet))
    fail('Invalid stationAet');
  const n=Number(limit);
  if(!Number.isSafeInteger(n)||n<1||n>100)fail('limit must be 1..100');
  return (await pool.query(`SELECT * FROM ris_worklist_orders
    WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR scheduled_station_aet=$2)
    ORDER BY scheduled_start_date,scheduled_start_time,id LIMIT $3`,
    [status??null,stationAet??null,n])).rows;
}
export async function getWorklistOrder(pool,id){
  if(!Number.isSafeInteger(id)||id<1)fail('Invalid order id');
  const r=await pool.query('SELECT * FROM ris_worklist_orders WHERE id=$1',[id]);
  if(!r.rowCount)fail('Order not found',404);
  return r.rows[0];
}
const transitions={
  scheduled:new Set(['on_hold','completed','cancelled']),
  on_hold:new Set(['scheduled','cancelled']),
  completed:new Set([]),
  cancelled:new Set([])
};
export async function changeWorklistOrderStatus(pool,id,next) {
  if(!Number.isSafeInteger(id)||id<1)fail('Invalid order id');
  if(typeof next!=='string'||!Object.hasOwn(transitions,next))
    fail('Invalid worklist status');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const curr=await client.query('SELECT * FROM ris_worklist_orders WHERE id=$1 FOR UPDATE',[id]);
    if(!curr.rowCount)fail('Order not found',404);
    if(!transitions[curr.rows[0].status]?.has(next))
      fail('Invalid state transition',409);
    const updated=await client.query(`UPDATE ris_worklist_orders
      SET status=$2,updated_at=now() WHERE id=$1 RETURNING *`,[id,next]);
    await client.query('INSERT INTO audit_events(event_type,reference_uid,details) VALUES($1,$2,$3)',
      ['mwl_order_status',curr.rows[0].study_instance_uid,JSON.stringify({
        from:curr.rows[0].status,to:next,stationAet:curr.rows[0].scheduled_station_aet
      })]);
    await client.query('COMMIT');
    return updated.rows[0];
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{client.release();}
}
