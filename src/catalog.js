import pg from 'pg';
import { parseDicom } from './dicom.js';
import { storeObject, sha256, readObject } from './storage.js';
import { enqueueRoutesForIngest } from './routing.js';

export class PacsCatalog {
  constructor(conf) {
    this.conf = conf;
    this.pool = new pg.Pool({ connectionString: conf.databaseUrl, max: 10 });
  }
  async close() { await this.pool.end(); }
  async ingest(bytes) {
    const parsed = parseDicom(bytes);
    const digest = sha256(bytes);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const old = await c.query('SELECT sha256 FROM instances WHERE instance_uid=$1 FOR UPDATE', [parsed.instanceUID]);
      if (old.rowCount) {
        if (old.rows[0].sha256 !== digest) throw Object.assign(new Error('SOP Instance UID collision with different contents'), { statusCode: 409 });
        await c.query('COMMIT');
        return { status: 'duplicate', ...parsed };
      }
      const existingStudy = await c.query('SELECT patient_id FROM studies WHERE study_uid=$1', [parsed.studyUID]);
      if (existingStudy.rowCount && existingStudy.rows[0].patient_id !== parsed.patientId)
        throw Object.assign(new Error('Study UID belongs to a different patient'), { statusCode: 409 });
      const existingSeries = await c.query('SELECT study_uid FROM series WHERE series_uid=$1', [parsed.seriesUID]);
      if (existingSeries.rowCount && existingSeries.rows[0].study_uid !== parsed.studyUID)
        throw Object.assign(new Error('Series UID belongs to a different study'), { statusCode: 409 });
      await storeObject(this.conf.storageRoot, bytes);
      await c.query(`INSERT INTO studies(study_uid,patient_id,patient_name,accession_number,study_date,study_description)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (study_uid) DO NOTHING`,
        [parsed.studyUID, parsed.patientId, parsed.patientName, parsed.accession, parsed.studyDate, parsed.studyDescription]);
      // Re-check after conflict resolution: concurrent ingesters may race on new UIDs.
      const committedStudy = await c.query('SELECT patient_id FROM studies WHERE study_uid=$1',[parsed.studyUID]);
      if (committedStudy.rows[0]?.patient_id !== parsed.patientId)
        throw Object.assign(new Error('Conflicting patient for study UID'), {statusCode:409});
      await c.query(`INSERT INTO series(series_uid,study_uid,modality,series_number) VALUES($1,$2,$3,$4)
        ON CONFLICT (series_uid) DO NOTHING`,
        [parsed.seriesUID, parsed.studyUID, parsed.modality, parsed.seriesNumber]);
      const committedSeries = await c.query('SELECT study_uid FROM series WHERE series_uid=$1',[parsed.seriesUID]);
      if (committedSeries.rows[0]?.study_uid !== parsed.studyUID)
        throw Object.assign(new Error('Conflicting parent study for series UID'), {statusCode:409});
      const inserted = await c.query(`INSERT INTO instances(instance_uid,series_uid,study_uid,sop_class_uid,transfer_syntax_uid,sha256,size_bytes,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (instance_uid) DO NOTHING RETURNING instance_uid`,
        [parsed.instanceUID, parsed.seriesUID, parsed.studyUID, parsed.sopClassUID, parsed.transferSyntax, digest, bytes.length, parsed.metadata]);
      if (!inserted.rowCount) {
        const raced = await c.query('SELECT sha256 FROM instances WHERE instance_uid=$1', [parsed.instanceUID]);
        if (!raced.rowCount || raced.rows[0].sha256 !== digest)
          throw Object.assign(new Error('SOP Instance UID collision'), { statusCode: 409 });
      }
      if (inserted.rowCount) await enqueueRoutesForIngest(c,parsed);
      await c.query('INSERT INTO audit_events(event_type,reference_uid,details) VALUES($1,$2,$3)',
        ['instance_ingest', parsed.instanceUID, JSON.stringify({ digest, source: 'dicom_ingress' })]);
      await c.query('COMMIT');
      return { status: inserted.rowCount ? 'stored' : 'duplicate', ...parsed };
    } catch(error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { c.release(); }
  }
  async studies(q) {
    const limit = Math.min(Math.max(Number(q.limit) || 20,1),100);
    const offset = Math.min(Math.max(Number(q.offset) || 0,0),100000);
    const args = [];
    const conditions=[];
    for (const [keyword,tag,field] of [
      ['PatientID','00100020','patient_id'],
      ['StudyInstanceUID','0020000D','study_uid'],
      ['AccessionNumber','00080050','accession_number'],
      ['StudyDate','00080020','study_date']
    ]) {
      for (const value of new Set([q[keyword],q[tag],q[tag.toLowerCase()]])) {
        if(value) {args.push(value);conditions.push(`${field}=$${args.length}`);}
      }
    }
    args.push(limit,offset);
    const sql = `SELECT s.*, (SELECT count(*)::int FROM series x WHERE x.study_uid=s.study_uid) AS series_count,
      (SELECT count(*)::int FROM instances i WHERE i.study_uid=s.study_uid) AS instance_count
      FROM studies s ${conditions.length?'WHERE '+conditions.join(' AND '):''}
      ORDER BY s.created_at DESC LIMIT $${args.length-1} OFFSET $${args.length}`;
    return (await this.pool.query(sql,args)).rows;
  }
  async series(studyUID) {
    return (await this.pool.query('SELECT * FROM series WHERE study_uid=$1 ORDER BY series_uid', [studyUID])).rows;
  }
  async instances(studyUID, seriesUID) {
    const query = seriesUID
      ? 'SELECT * FROM instances WHERE study_uid=$1 AND series_uid=$2 ORDER BY instance_uid'
      : 'SELECT * FROM instances WHERE study_uid=$1 ORDER BY instance_uid';
    return (await this.pool.query(query,seriesUID?[studyUID,seriesUID]:[studyUID])).rows;
  }
  async instance(studyUID,seriesUID,instanceUID) {
    return (await this.pool.query('SELECT * FROM instances WHERE study_uid=$1 AND series_uid=$2 AND instance_uid=$3',
      [studyUID,seriesUID,instanceUID])).rows[0];
  }
  async bytesFor(row) { return readObject(this.conf.storageRoot, row.sha256); }
  async nodes() { return (await this.pool.query('SELECT aet,host,port,enabled FROM ae_nodes ORDER BY aet')).rows; }
  async node(aet) { return (await this.pool.query('SELECT aet,host,port,enabled FROM ae_nodes WHERE aet=$1 AND enabled=TRUE',[aet])).rows[0]; }
  async upsertNode({aet,host,port,enabled=true}) {
    if (!/^[A-Z0-9_-]{1,16}$/.test(aet??'') || typeof host!=='string' || !/^[\w.:-]{1,253}$/.test(host)
        || !Number.isInteger(port) || port<1 || port>65535 || typeof enabled!=='boolean')
      throw Object.assign(new Error('Invalid AE configuration'),{statusCode:400});
    await this.pool.query(`INSERT INTO ae_nodes(aet,host,port,enabled) VALUES($1,$2,$3,$4)
       ON CONFLICT(aet) DO UPDATE SET host=EXCLUDED.host,port=EXCLUDED.port,enabled=EXCLUDED.enabled`,[aet,host,port,enabled]);
    return {aet,host,port,enabled};
  }
}
