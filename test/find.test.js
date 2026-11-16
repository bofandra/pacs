import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFind, findStudyRoot,FindQueryError } from '../src/find-query.js';

test('Study Root FIND rejects unsafe or unsupported matching',()=>{
  assert.equal(normalizeFind({QueryRetrieveLevel:'STUDY',PatientID:'ID*'}).PatientID,'ID*');
  assert.throws(()=>normalizeFind({QueryRetrieveLevel:'SERIES'}),/StudyInstanceUID/);
  assert.throws(()=>normalizeFind({QueryRetrieveLevel:'IMAGE',StudyInstanceUID:'1.2.3'}),/SeriesInstanceUID/);
  assert.throws(()=>normalizeFind({QueryRetrieveLevel:'STUDY',PatientBirthDate:'20200101'}),/Unsupported/);
  assert.throws(()=>normalizeFind({QueryRetrieveLevel:'STUDY',StudyInstanceUID:'abc'}),/Invalid/);
  assert.throws(()=>normalizeFind({QueryRetrieveLevel:'STUDY',PatientID:'X'.repeat(130)}),/too long/);
});
test('C-FIND wildcard matching is parameterized, escaped and results are bounded',async()=>{
  let observed;
  const pool={query:async (sql,args)=>{
    observed={sql,args};
    return {rows:[{study_uid:'1.2.3',patient_id:'TEST_123',patient_name:'DOE^TEST',
      accession_number:'',study_date:'20261115',study_description:'',series_count:1,instance_count:1}]};
  }};
  const matches=await findStudyRoot(pool,{QueryRetrieveLevel:'STUDY',PatientID:'TEST_12?',StudyDate:'20261101-20261130'});
  assert.equal(matches.length,1);
  assert.equal(matches[0].QueryRetrieveLevel,'STUDY');
  assert.equal(matches[0].StudyInstanceUID,'1.2.3');
  assert.ok(observed.sql.includes('ESCAPE'));
  assert.equal(observed.args[0],'TEST\\_12_');
  assert.equal(observed.args.at(-1),101);
  const over={query:async()=>({rows:Array.from({length:101},()=>({}))})};
  await assert.rejects(findStudyRoot(over,{QueryRetrieveLevel:'STUDY'}),e=>
    e instanceof FindQueryError && e.code==='TOO_MANY_RESULTS');
});
