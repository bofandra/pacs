import {getWorklistOrder} from './mwl-orders.js';

// Advisory comparison of imaging data against a worklist order.
// NEVER automatically link/merge patient identities based on this comparison.
// The Issuer of Accession Number Sequence is not currently parsed from DICOM,
// so even fully consistent values are not a formally confirmed identity match.
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
  const issuers=rows.map(r=>r.metadata?.['00100021']?.Value?.[0]??null);
  if(issuers.some(x=>x!==null && x!==order.issuer_of_patient_id))
    summary.issuerOfPatientIdMatches=false;
  else if(rows.length>0&&rows.length<=100&&issuers.every(x=>x===order.issuer_of_patient_id))
    summary.issuerOfPatientIdMatches=true;
  if(!summary.patientIdMatches||!summary.accessionNumberMatches ||
     summary.issuerOfPatientIdMatches===false)summary.status='mismatch';
  else if(summary.issuerOfPatientIdMatches===true)
    summary.status='identity_consistent';
  else summary.status='insufficient_evidence';
  return summary;
}
