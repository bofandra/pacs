// PostgreSQL-backed Study Root C-FIND query engine.
// Only whitelisted keys and bounded queries are accepted; never interpolate user text in SQL.
import { validUID } from './dicom.js';

export class FindQueryError extends Error {
  constructor(message, code = 'INVALID_QUERY') {
    super(message);
    this.code = code;
  }
}
const keySets = {
  STUDY: new Set(['QueryRetrieveLevel','PatientID','PatientName','StudyInstanceUID',
    'AccessionNumber','StudyDate','StudyDescription','ModalitiesInStudy']),
  SERIES: new Set(['QueryRetrieveLevel','StudyInstanceUID','SeriesInstanceUID',
    'Modality','SeriesNumber','PatientID']),
  IMAGE: new Set(['QueryRetrieveLevel','StudyInstanceUID','SeriesInstanceUID',
    'SOPInstanceUID','InstanceNumber','PatientID'])
};
const MAX_FIND_RESULTS = 100;
function scalar(value, key='value') {
  if(value == null) return '';
  if(Array.isArray(value)) {
    if(value.length > 1) throw new FindQueryError('Multiple-valued matching not supported');
    return scalar(value[0],key);
  }
  if(typeof value==='object' && !Array.isArray(value)) {
    // dcmjs represents PN values as { Alphabetic: ... } in some versions.
    if(Object.hasOwn(value,'Alphabetic')) return scalar(value.Alphabetic,key);
    if(Object.hasOwn(value,'Value')) return scalar(value.Value,key);
    if(Object.keys(value).length===0) return '';
  }
  if(typeof value !== 'string' && typeof value !== 'number')
    throw new FindQueryError('Invalid C-FIND matching value type for '+key);
  const s=String(value).replace(/\u0000+$/g,'').trim();
  if(s.length > 128) throw new FindQueryError('C-FIND matching value too long');
  return s;
}
export function normalizeFind(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new FindQueryError('C-FIND dataset must be an object');
  const level=scalar(input.QueryRetrieveLevel).toUpperCase();
  if(!keySets[level]) throw new FindQueryError('Unsupported QueryRetrieveLevel');
  const normalized={QueryRetrieveLevel:level};
  for(const [key,value] of Object.entries(input)) {
    if(key==='QueryRetrieveLevel') continue;
    const str=scalar(value,key);
    if(str && !keySets[level].has(key)) throw new FindQueryError('Unsupported matching key: '+key);
    if(str) normalized[key]=str;
  }
  if(['SERIES','IMAGE'].includes(level) && !validUID(normalized.StudyInstanceUID))
    throw new FindQueryError('StudyInstanceUID required for hierarchical query');
  if(level==='IMAGE' && !validUID(normalized.SeriesInstanceUID))
    throw new FindQueryError('SeriesInstanceUID required for IMAGE query');
  for (const key of ['StudyInstanceUID','SeriesInstanceUID','SOPInstanceUID']) {
    if(normalized[key] && !validUID(normalized[key])) throw new FindQueryError('Invalid '+key);
  }
  return normalized;
}
function likePattern(value) {
  // DICOM '*' and '?' wildcard matching. Escape SQL pattern metacharacters.
  return value.replace(/[\\%_]/g,'\\$&').replace(/\*/g,'%').replace(/\?/g,'_');
}
function addMatch(where,params,column,value,insensitive=false) {
  if(!value) return;
  params.push(likePattern(value));
  where.push(`${column} ${insensitive?'ILIKE':'LIKE'} $${params.length} ESCAPE '\\'`);
}
function addDate(where,params,date) {
  if(!date) return;
  const match=/^(\d{8})?-(\d{8})?$/.exec(date);
  if(match) {
    if(!match[1] && !match[2]) throw new FindQueryError('Empty StudyDate range');
    if(match[1]) {params.push(match[1]);where.push(`s.study_date >= $${params.length}`);}
    if(match[2]) {params.push(match[2]);where.push(`s.study_date <= $${params.length}`);}
  } else if(/^\d{8}$/.test(date)) {
    params.push(date);where.push(`s.study_date = $${params.length}`);
  } else throw new FindQueryError('Unsupported StudyDate matching syntax');
}
function recordDataset(r,level) {
  const base={
    QueryRetrieveLevel:level,
    PatientID:r.patient_id||'',
    PatientName:r.patient_name||'',
    StudyInstanceUID:r.study_uid,
    AccessionNumber:r.accession_number||'',
    StudyDate:r.study_date||'',
    StudyDescription:r.study_description||''
  };
  if(level==='STUDY') return {
    ...base,NumberOfStudyRelatedSeries:Number(r.series_count)||0,
    NumberOfStudyRelatedInstances:Number(r.instance_count)||0
  };
  if(level==='SERIES') return {
    ...base,SeriesInstanceUID:r.series_uid,Modality:r.modality||'',
    SeriesNumber:r.series_number||''
  };
  const meta=r.metadata??{};
  return {
    ...base,SeriesInstanceUID:r.series_uid,SOPInstanceUID:r.instance_uid,
    SOPClassUID:r.sop_class_uid,Modality:r.modality||'',
    InstanceNumber:meta['00200013']?.Value?.[0]??''
  };
}

export async function findStudyRoot(pool,input,{maxResults=MAX_FIND_RESULTS}={}) {
  const q=normalizeFind(input);
  if(!Number.isInteger(maxResults)||maxResults<1||maxResults>MAX_FIND_RESULTS)
    throw new FindQueryError('Invalid query result limit');
  const level=q.QueryRetrieveLevel;
  const joins=level==='STUDY'?'':level==='SERIES'
    ?' JOIN series se ON se.study_uid=s.study_uid'
    :' JOIN series se ON se.study_uid=s.study_uid JOIN instances i ON i.series_uid=se.series_uid';
  const where=[];const params=[];
  addMatch(where,params,'s.patient_id',q.PatientID);
  if(level==='STUDY') {
    addMatch(where,params,'s.patient_name',q.PatientName,true);
    addMatch(where,params,'s.accession_number',q.AccessionNumber);
    addMatch(where,params,'s.study_description',q.StudyDescription,true);
    addDate(where,params,q.StudyDate);
    if(q.ModalitiesInStudy) {
      params.push(likePattern(q.ModalitiesInStudy));
      where.push(`EXISTS (SELECT 1 FROM series sx WHERE sx.study_uid=s.study_uid
        AND sx.modality LIKE $${params.length} ESCAPE '\\')`);
    }
  }
  if(q.StudyInstanceUID) {params.push(q.StudyInstanceUID);where.push(`s.study_uid=$${params.length}`);}
  if(q.SeriesInstanceUID) {params.push(q.SeriesInstanceUID);where.push(`se.series_uid=$${params.length}`);}
  if(q.SOPInstanceUID) {params.push(q.SOPInstanceUID);where.push(`i.instance_uid=$${params.length}`);}
  if(q.Modality && level==='SERIES') addMatch(where,params,'se.modality',q.Modality);
  if(q.SeriesNumber && level==='SERIES') addMatch(where,params,'se.series_number',q.SeriesNumber);
  if(q.InstanceNumber && level==='IMAGE') {
    if(!/^\d+$/.test(q.InstanceNumber)) throw new FindQueryError('Invalid InstanceNumber');
    params.push(Number(q.InstanceNumber));
    where.push(`i.metadata -> '00200013' -> 'Value' ->> 0 = $${params.length}::text`);
  }
  const projection=level==='STUDY'
    ?`s.*, (SELECT count(*)::int FROM series se WHERE se.study_uid=s.study_uid) AS series_count,
       (SELECT count(*)::int FROM instances i WHERE i.study_uid=s.study_uid) AS instance_count`
    :level==='SERIES'
    ?'s.*,se.series_uid,se.modality,se.series_number'
    :'s.*,se.series_uid,se.modality,i.instance_uid,i.sop_class_uid,i.metadata';
  params.push(maxResults+1);
  const sql=`SELECT ${projection} FROM studies s ${joins}
    ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY s.study_uid ${level==='STUDY'?'':', se.series_uid'} ${level==='IMAGE'?',i.instance_uid':''}
    LIMIT $${params.length}`;
  const rows=(await pool.query(sql,params)).rows;
  if(rows.length>maxResults) throw new FindQueryError('Too many matching results','TOO_MANY_RESULTS');
  return rows.map(r=>recordDataset(r,level));
}
