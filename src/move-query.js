// Strict Study Root C-MOVE selection: bounded explicit UID hierarchy only.
// A missing/unsupported UID cannot be treated as a request to send the entire archive.
import { validUID } from './dicom.js';

export class MoveSelectionError extends Error {
  constructor(message,code='INVALID_MOVE') { super(message); this.code=code; }
}
function value(v,key='identifier') {
  if(v==null)return '';
  if(Array.isArray(v)) {
    if(v.length===0)return '';
    if(v.length!==1)throw new MoveSelectionError('Ambiguous identifier: '+key);
    return value(v[0],key);
  }
  if(typeof v==='object') {
    if(Object.hasOwn(v,'Value')) return value(v.Value,key);
    if(Object.hasOwn(v,'Alphabetic')) return value(v.Alphabetic,key);
    if(Object.keys(v).length===0)return '';
  }
  if(typeof v!=='string')throw new MoveSelectionError('Invalid identifier type for '+key);
  return v.trim().replace(/\u0000+$/g,'');
}
export function normalizeMove(input) {
  if(!input || typeof input!=='object' || Array.isArray(input))
    throw new MoveSelectionError('Missing C-MOVE identifier');
  const level=value(input.QueryRetrieveLevel||'').toUpperCase();
  if(!['STUDY','SERIES','IMAGE'].includes(level))
    throw new MoveSelectionError('Unsupported C-MOVE query level');
  const permitted={
    STUDY:['QueryRetrieveLevel','StudyInstanceUID'],
    SERIES:['QueryRetrieveLevel','StudyInstanceUID','SeriesInstanceUID'],
    IMAGE:['QueryRetrieveLevel','StudyInstanceUID','SeriesInstanceUID','SOPInstanceUID']
  }[level];
  for(const [key,v] of Object.entries(input)) {
    if(!permitted.includes(key) && v!==undefined && v!==null && value(v,key)!=='')
      throw new MoveSelectionError('Unsupported C-MOVE matching key');
  }
  const selected={level};
  for(const k of permitted.filter(x=>x!=='QueryRetrieveLevel')) {
    const v=value(input[k]||'',k);
    if(!validUID(v)) throw new MoveSelectionError('Missing or invalid '+k);
    selected[k]=v;
  }
  return selected;
}
export async function selectMoveInstances(pool,identifier,{limit=10}={}) {
  const q=normalizeMove(identifier);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)
    throw new MoveSelectionError('Invalid C-MOVE limit');
  const params=[q.StudyInstanceUID]; const where=['i.study_uid=$1'];
  if(q.SeriesInstanceUID) {params.push(q.SeriesInstanceUID);where.push(`i.series_uid=$${params.length}`);}
  if(q.SOPInstanceUID) {params.push(q.SOPInstanceUID);where.push(`i.instance_uid=$${params.length}`);}
  params.push(limit+1);
  const query=`SELECT i.study_uid,i.series_uid,i.instance_uid,i.sop_class_uid,
      i.transfer_syntax_uid,i.sha256
    FROM instances i WHERE ${where.join(' AND ')}
    ORDER BY i.series_uid,i.instance_uid LIMIT $${params.length}`;
  const rows=(await pool.query(query,params)).rows;
  if(rows.length>limit)throw new MoveSelectionError('C-MOVE result set too large','TOO_MANY_INSTANCES');
  return rows;
}
