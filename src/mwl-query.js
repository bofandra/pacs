// DICOM Modality Worklist Information Model – FIND (1.2.840.10008.5.1.4.31)
// Prototype matching subset of DICOM PS3.4 K.6. Strict per-calling-AET scoping.
import { validDicomDate } from './dicom.js';

export class MwlQueryError extends Error {
  constructor(message,code='INVALID_MWL_QUERY'){super(message);this.code=code;}
}
const topKeys=new Set([
  'SpecificCharacterSet','PatientID','IssuerOfPatientID','PatientName',
  'PatientBirthDate','PatientSex','AccessionNumber','RequestedProcedureID',
  'RequestedProcedureDescription','StudyInstanceUID','ScheduledProcedureStepSequence'
]);
const spsKeys=new Set([
  'ScheduledStationAETitle','ScheduledProcedureStepStartDate',
  'ScheduledProcedureStepStartTime','Modality','ScheduledProcedureStepID',
  'ScheduledProcedureStepDescription','ScheduledStationName',
  'ScheduledProcedureStepLocation','ScheduledPerformingPhysicianName'
]);
function scalar(value,key){
  if(value===null||value===undefined)return '';
  if(Array.isArray(value)) {
    if(value.length===0)return '';
    if(value.length!==1)throw new MwlQueryError('Multiple values unsupported for '+key);
    return scalar(value[0],key);
  }
  if(typeof value==='object') {
    if(Object.hasOwn(value,'Alphabetic'))return scalar(value.Alphabetic,key);
    if(Object.hasOwn(value,'Value'))return scalar(value.Value,key);
    if(Object.keys(value).length===0)return '';
    throw new MwlQueryError('Invalid worklist attribute type for '+key);
  }
  if(typeof value!=='string'&&typeof value!=='number')
    throw new MwlQueryError('Invalid worklist attribute type for '+key);
  const s=String(value).replace(/\u0000+$/g,'').trim();
  if(s.length>128)throw new MwlQueryError('MWL matching value too long');
  return s;
}
function dateBounds(value,key){
  if(!value)return null;
  if(validDicomDate(value))return [value,value];
  const m=/^(\d{8})?-(\d{8})?$/.exec(value);
  if(!m||(!m[1]&&!m[2])||[m[1],m[2]].some(bound=>bound&&!validDicomDate(bound)))
    throw new MwlQueryError('Invalid '+key+' range');
  if(m[1]&&m[2]&&m[1]>m[2])throw new MwlQueryError('Reversed '+key+' range');
  return [m[1]??null,m[2]??null];
}
function timeEndpoint(value,endOfPrecision=false){
  const padded=value.padEnd(6,'0');
  if(Number(padded.slice(0,2))>23||Number(padded.slice(2,4))>59||Number(padded.slice(4,6))>59)
    throw new MwlQueryError('Invalid Scheduled Procedure Step Start Time');
  if(endOfPrecision&&value.length===2)return value+'5959';
  if(endOfPrecision&&value.length===4)return value+'59';
  return padded;
}
function timeBounds(value){
  if(!value)return null;
  if(/^\d{2}(?:\d{2}(?:\d{2})?)?$/.test(value)){
    const padded=timeEndpoint(value);
    return [padded,padded];
  }
  const m=/^(\d{2}(?:\d{2}(?:\d{2})?)?)?-(\d{2}(?:\d{2}(?:\d{2})?)?)?$/.exec(value);
  if(!m||(!m[1]&&!m[2]))throw new MwlQueryError('Invalid Scheduled Procedure Step Start Time range');
  const start=m[1]?timeEndpoint(m[1]):null;
  const end=m[2]?timeEndpoint(m[2],true):null;
  return [start,end];
}
export function normalizeMwlQuery(input,{callingAet}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))
    throw new MwlQueryError('Invalid MWL identifier');
  if(!/^[A-Z0-9_-]{1,16}$/.test(callingAet??''))
    throw new MwlQueryError('No authorized calling AE');
  for(const [key,value]of Object.entries(input)){
    if(!topKeys.has(key)&&scalar(value,key)!=='')
      throw new MwlQueryError('Unsupported worklist matching key: '+key);
  }
  if(!Array.isArray(input.ScheduledProcedureStepSequence) ||
      input.ScheduledProcedureStepSequence.length!==1)
    throw new MwlQueryError('ScheduledProcedureStepSequence must contain one item');
  const item=input.ScheduledProcedureStepSequence[0];
  if(!item||typeof item!=='object'||Array.isArray(item))
    throw new MwlQueryError('Invalid ScheduledProcedureStepSequence item');
  for(const [key,value]of Object.entries(item)){
    if(!spsKeys.has(key)&&scalar(value,key)!=='')
      throw new MwlQueryError('Unsupported scheduled step matching key: '+key);
  }
  const station=scalar(item.ScheduledStationAETitle,'ScheduledStationAETitle');
  if(station && station!==callingAet)
    throw new MwlQueryError('Requested station must equal calling AE Title');
  const keys={callingAet};
  for(const key of topKeys){
    if(key==='ScheduledProcedureStepSequence')continue;
    keys[key]=scalar(input[key],key);
  }
  for(const key of spsKeys)keys[key]=scalar(item[key],key);
  // ASCII/UTF8 character handling: only ISO_IR 192 is explicitly negotiated in
  // our prototype; an empty SpecificCharacterSet is also a return-only key.
  if(keys.SpecificCharacterSet&&!['ISO_IR 192','ISO_IR 6'].includes(keys.SpecificCharacterSet))
    throw new MwlQueryError('Unsupported SpecificCharacterSet');
  keys.dateBounds=dateBounds(keys.ScheduledProcedureStepStartDate,'ScheduledProcedureStepStartDate');
  keys.timeBounds=timeBounds(keys.ScheduledProcedureStepStartTime);
  const [dateStart,dateEnd]=keys.dateBounds??[];
  const [timeStart,timeEnd]=keys.timeBounds??[];
  if(keys.ScheduledProcedureStepStartDate.includes('-')&&keys.ScheduledProcedureStepStartTime.includes('-')){
    // PS3.4 K.6 treats paired date/time ranges as one continuous interval.
    keys.scheduleBounds=[
      dateStart?dateStart+(timeStart??'000000'):null,
      dateEnd?dateEnd+(timeEnd??'235959'):null
    ];
    const [start,end]=keys.scheduleBounds;
    if(start&&end&&start>end)throw new MwlQueryError('Reversed schedule range');
  }else if(timeStart&&timeEnd&&timeStart>timeEnd){
    throw new MwlQueryError('Reversed time range');
  }
  return keys;
}
function like(value){
  return value.replace(/[\\%_]/g,'\\$&').replace(/\*/g,'%').replace(/\?/g,'_');
}
function add(where,args,column,value,insensitive=false){
  if(!value)return;
  args.push(like(value));
  where.push(`${column} ${insensitive?'ILIKE':'LIKE'} $${args.length} ESCAPE '\\'`);
}
function bounds(where,args,column,range){
  if(!range)return;
  if(range[0]){args.push(range[0]);where.push(`${column} >= $${args.length}`);}
  if(range[1]){args.push(range[1]);where.push(`${column} <= $${args.length}`);}
}
export function toMwlDataset(r){
  const step={
    ScheduledStationAETitle:r.scheduled_station_aet,
    ScheduledProcedureStepStartDate:r.scheduled_start_date,
    ScheduledProcedureStepStartTime:r.scheduled_start_time,
    Modality:r.modality,
    ScheduledProcedureStepID:r.scheduled_procedure_step_id,
    ScheduledProcedureStepDescription:r.scheduled_procedure_step_description,
    ScheduledPerformingPhysicianName:'',
    ScheduledStationName:'',
    ScheduledProcedureStepLocation:''
  };
  return {
    SpecificCharacterSet:'ISO_IR 192',
    PatientID:r.patient_id,
    IssuerOfPatientID:r.issuer_of_patient_id,
    PatientName:r.patient_name,
    PatientBirthDate:r.patient_birth_date??'',
    PatientSex:r.patient_sex??'',
    AccessionNumber:r.accession_number,
    IssuerOfAccessionNumberSequence:[{LocalNamespaceEntityID:r.accession_issuer}],
    StudyInstanceUID:r.study_instance_uid,
    RequestedProcedureID:r.requested_procedure_id,
    RequestedProcedureDescription:r.requested_procedure_description,
    ScheduledProcedureStepSequence:[step]
  };
}
export async function findModalityWorklist(pool,query,options={}) {
  const q=normalizeMwlQuery(query,options);
  const max=options.maxResults??50;
  if(!Number.isSafeInteger(max)||max<1||max>100)
    throw new MwlQueryError('Invalid MWL limit');
  // The caller can never see schedules of another station.
  const args=[q.callingAet];
  const where=["scheduled_station_aet=$1","status='scheduled'"];
  add(where,args,'patient_id',q.PatientID);
  add(where,args,'issuer_of_patient_id',q.IssuerOfPatientID);
  add(where,args,'patient_name',q.PatientName,true);
  add(where,args,'accession_number',q.AccessionNumber);
  add(where,args,'requested_procedure_id',q.RequestedProcedureID);
  add(where,args,'requested_procedure_description',q.RequestedProcedureDescription,true);
  add(where,args,'study_instance_uid',q.StudyInstanceUID);
  add(where,args,'scheduled_procedure_step_id',q.ScheduledProcedureStepID);
  add(where,args,'scheduled_procedure_step_description',q.ScheduledProcedureStepDescription,true);
  add(where,args,'modality',q.Modality);
  add(where,args,'patient_birth_date',q.PatientBirthDate);
  add(where,args,'patient_sex',q.PatientSex);
  if(q.scheduleBounds){
    bounds(where,args,'(scheduled_start_date || scheduled_start_time)',q.scheduleBounds);
  }else{
    bounds(where,args,'scheduled_start_date',q.dateBounds);
    bounds(where,args,'scheduled_start_time',q.timeBounds);
  }
  args.push(max+1);
  const sql=`SELECT * FROM ris_worklist_orders WHERE ${where.join(' AND ')}
    ORDER BY scheduled_start_date,scheduled_start_time,id LIMIT $${args.length}`;
  const rows=(await pool.query(sql,args)).rows;
  if(rows.length>max)throw new MwlQueryError('Too many worklist matches','TOO_MANY_MATCHES');
  return rows.map(toMwlDataset);
}
