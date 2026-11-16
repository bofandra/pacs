import { randomUUID } from 'node:crypto';
import { validUID } from './dicom.js';

const AE_RE=/^[A-Z0-9_-]{1,16}$/;
const MOD_RE=/^[A-Z0-9_]{1,16}$/;
const STATES=['queued','sending','succeeded','dead_letter'];
const bad=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});

export function validateRoute({destinationAet, modality=null, enabled=false}) {
  if (!AE_RE.test(destinationAet??'')) throw bad('Invalid destination AE title');
  if (modality !== null && !MOD_RE.test(modality)) throw bad('Invalid modality');
  if (typeof enabled !== 'boolean') throw bad('enabled must be boolean');
  return {destinationAet,modality,enabled};
}

export async function listRules(pool) {
  return (await pool.query('SELECT * FROM routing_rules ORDER BY id')).rows;
}
export async function addRule(pool,input) {
  const v=validateRoute(input??{});
  const ae=await pool.query('SELECT enabled FROM ae_nodes WHERE aet=$1',[v.destinationAet]);
  if (!ae.rowCount) throw bad('Destination AE must be registered',404);
  // Disabled by default. Explicitly opt-in only after an operator has verified the peer.
  try {
    const row=await pool.query(
      'INSERT INTO routing_rules(destination_aet,modality,enabled) VALUES($1,$2,$3) RETURNING *',
      [v.destinationAet,v.modality,v.enabled]);
    return row.rows[0];
  } catch(error) {
    if(error.code==='23505') throw bad('Route for destination and modality already exists',409);
    throw error;
  }
}
export async function setRuleEnabled(pool,id,enabled) {
  if(typeof enabled!=='boolean') throw bad('enabled must be boolean');
  if(!Number.isSafeInteger(id)||id<1) throw bad('Invalid route ID');
  const row=await pool.query(
    'UPDATE routing_rules SET enabled=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,enabled]);
  if(!row.rowCount) throw bad('Route not found',404);
  return row.rows[0];
}

// Must run inside the SAME transaction as the new instance catalog insertion.
// A repeated SOP Instance UID does not create another delivery.
export async function enqueueRoutesForIngest(client,{instanceUID,modality}) {
  const rows=await client.query(
    `INSERT INTO delivery_jobs(instance_uid,destination_aet)
     SELECT $1, r.destination_aet
     FROM routing_rules r JOIN ae_nodes n ON n.aet=r.destination_aet
     WHERE r.enabled=TRUE AND n.enabled=TRUE
       AND (r.modality IS NULL OR r.modality=$2)
     ON CONFLICT (instance_uid,destination_aet) DO NOTHING
     RETURNING id`,[instanceUID,modality]);
  return rows.rowCount;
}
export async function enqueueManual(pool,{instanceUID,destinationAet}) {
  if(!validUID(instanceUID)) throw bad('Invalid SOP Instance UID');
  if(!AE_RE.test(destinationAet??'')) throw bad('Invalid destination AE title');
  const node=await pool.query('SELECT aet FROM ae_nodes WHERE aet=$1 AND enabled=TRUE',[destinationAet]);
  if(!node.rowCount) throw bad('Destination AE not found or disabled',404);
  const result=await pool.query(
    `INSERT INTO delivery_jobs(instance_uid,destination_aet)
     SELECT i.instance_uid,$2 FROM instances i WHERE i.instance_uid=$1
     ON CONFLICT (instance_uid,destination_aet) DO NOTHING RETURNING *`,
    [instanceUID,destinationAet]);
  if(result.rowCount) return result.rows[0];
  const old=await pool.query('SELECT * FROM delivery_jobs WHERE instance_uid=$1 AND destination_aet=$2',[instanceUID,destinationAet]);
  if(old.rowCount) return old.rows[0];
  throw bad('Instance not found',404);
}
export async function listJobs(pool,{status,limit=50}={}) {
  if(status && !STATES.includes(status)) throw bad('Invalid delivery status');
  const n=Number(limit);
  if(!Number.isSafeInteger(n)||n<1||n>100) throw bad('limit must be 1..100');
  return (await pool.query(
    `SELECT * FROM delivery_jobs WHERE ($1::text IS NULL OR status=$1)
     ORDER BY id DESC LIMIT $2`,[status??null,n])).rows;
}
export async function retryJob(pool,id) {
  if(!Number.isSafeInteger(id)||id<1) throw bad('Invalid job ID');
  const row=await pool.query(`
    UPDATE delivery_jobs SET status='queued', attempts=0, error_code=NULL,
      lease_token=NULL, lease_expires_at=NULL, next_attempt_at=now(),updated_at=now()
    WHERE id=$1 AND status='dead_letter' AND
      EXISTS(SELECT 1 FROM ae_nodes n WHERE n.aet=delivery_jobs.destination_aet AND n.enabled=TRUE)
    RETURNING *`,[id]);
  if(!row.rowCount) throw bad('Job not in dead_letter or destination disabled',409);
  return row.rows[0];
}
export async function claimJob(pool) {
  // Expired leases after the final attempt cannot be reclaimed forever.
  await pool.query(`UPDATE delivery_jobs SET status='dead_letter',lease_token=NULL,
    lease_expires_at=NULL,error_code='LEASE_EXPIRED',updated_at=now()
    WHERE status='sending' AND lease_expires_at<now() AND attempts>=max_attempts`);
  const lease=randomUUID();
  const res=await pool.query(`
    WITH available AS (
      SELECT j.id FROM delivery_jobs j
      JOIN ae_nodes n ON n.aet=j.destination_aet AND n.enabled=TRUE
      WHERE j.attempts<j.max_attempts AND
       ((j.status='queued' AND j.next_attempt_at<=now())
        OR (j.status='sending' AND j.lease_expires_at<now()))
      ORDER BY j.next_attempt_at,j.id
      FOR UPDATE OF j SKIP LOCKED LIMIT 1
    )
    UPDATE delivery_jobs j SET status='sending', attempts=j.attempts+1,
      lease_token=$1::uuid,lease_expires_at=now()+interval '180 seconds',
      updated_at=now()
    FROM available a WHERE j.id=a.id RETURNING j.*`,[lease]);
  return res.rows[0]??null;
}
export async function finishJob(pool,job,success,errorCode=null) {
  if(!job || !Number.isSafeInteger(Number(job.id)) || !job.lease_token) throw bad('Invalid leased job');
  const attempts=Number(job.attempts);
  const finalState=success?'succeeded':attempts>=Number(job.max_attempts)?'dead_letter':'queued';
  const backoff=Math.min(3600,5*Math.pow(2,Math.min(attempts,10)));
  const code=success?null: typeof errorCode==='string' && /^[A-Z_]{1,40}$/.test(errorCode)?errorCode:'DELIVERY_FAILED';
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const updated=await client.query(`
      UPDATE delivery_jobs SET status=$3,error_code=$4,lease_token=NULL,
        lease_expires_at=NULL,updated_at=now(),
        next_attempt_at=CASE WHEN $3='queued' THEN now()+($5::int * interval '1 second') ELSE next_attempt_at END,
        sent_at=CASE WHEN $3='succeeded' THEN now() ELSE sent_at END
      WHERE id=$1 AND lease_token=$2::uuid AND status='sending'
      RETURNING *`,[job.id,job.lease_token,finalState,code,backoff]);
    if(updated.rowCount) {
      await client.query(
        'INSERT INTO audit_events(event_type,reference_uid,details) VALUES($1,$2,$3)',
        ['delivery_'+finalState,job.instance_uid,JSON.stringify({jobId:Number(job.id),destinationAet:job.destination_aet,attempts})]);
    }
    await client.query('COMMIT');
    return updated.rows[0]??null;
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}
