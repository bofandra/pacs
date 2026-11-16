import {getWorklistOrder} from './mwl-orders.js';

// Advisory comparison of imaging data against a worklist order.
// NEVER automatically link/merge patient identities based on this comparison.
// Only a DICOM Local Namespace Entity ID can be compared to the RIS issuer string.
function compareIssuers(received,expected) {
  if(received.some(value=>value!==null&&value!==expected))return false;
  if(received.length>0&&received.length<=100&&received.every(value=>value===expected))return true;
  return null;
}
export async function reconcileWorklistOrder(pool,id) {
  const order=await getWorklistOrder(pool,id);
  const study=(await pool.query(
    'SELECT study_uid,patient_id,accession_number FROM studies WHERE study_uid=$1',
    [order.study_instance_uid])).rows[0];
  const summary={
    orderId:Number(order.id),
    studyInstanceUID:order.study_instance_uid,
    status:'not_received',
    patientIdMatches:null,
    issuerOfPatientIdMatches:null,
    accessionNumberMatches:null,
    accessionIssuerMatches:null,
    accessionIssuerVerified:false,
    instanceCount:0,
    automaticPatientMerge:false
  };
  if(!study)return summary;
  const rows=(await pool.query(
    'SELECT metadata FROM instances WHERE study_uid=$1 ORDER BY instance_uid LIMIT 101',
    [order.study_instance_uid])).rows;
  summary.instanceCount=rows.length;
  summary.patientIdMatches=study.patient_id===order.patient_id;
  summary.accessionNumberMatches=study.accession_number===order.accession_number;
  // Bound work avoids unbounded DICOM metadata reads. Insufficient evidence
  // when >100 instances have not all been evaluated.
  summary.issuerOfPatientIdMatches=compareIssuers(
    rows.map(row=>row.metadata?.['00100021']?.Value?.[0]??null),order.issuer_of_patient_id);
  summary.accessionIssuerMatches=compareIssuers(
    rows.map(row=>row.metadata?.['00080051']?.Value?.[0]?.['00400031']?.Value?.[0]??null),
    order.accession_issuer);
  summary.accessionIssuerVerified=summary.accessionIssuerMatches===true;
  if(!summary.patientIdMatches||!summary.accessionNumberMatches ||
     summary.issuerOfPatientIdMatches===false||summary.accessionIssuerMatches===false)
    summary.status='mismatch';
  else if(summary.issuerOfPatientIdMatches===true)
    summary.status='identity_consistent';
  else summary.status='insufficient_evidence';
  return summary;
}
