import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorklistOrder,fingerprintOrder,WorklistOrderError} from '../src/mwl-orders.js';
import {normalizeMwlQuery,findModalityWorklist,toMwlDataset,MwlQueryError} from '../src/mwl-query.js';

const order={
 sourceSystem:'RIS_TEST',externalOrderId:'RIS-20261115-1',
 accessionIssuer:'RS_TEST',accessionNumber:'ACC202611150001',
 patientId:'SYNTHETIC001',issuerOfPatientId:'RS_TEST',
 patientName:'SYNTHETIC^PATIENT',patientBirthDate:'19820131',patientSex:'F',
 studyInstanceUID:'2.25.12345',requestedProcedureId:'RP123',
 requestedProcedureDescription:'Chest radiography',
 scheduledProcedureStepId:'SPS123',scheduledProcedureStepDescription:'CHEST XRAY',
 scheduledStationAETitle:'MWL_TEST_AE',modality:'CR',
 scheduledStartDate:'20261115',scheduledStartTime:'103000',
 scheduleTimezone:'Asia/Jakarta'
};
test('RIS order validation enforces issuer, station, schedule and immutable content',()=>{
 const n=normalizeWorklistOrder(order);
 assert.equal(n.accessionIssuer,'RS_TEST');
 assert.equal(n.issuerOfPatientId,'RS_TEST');
 assert.equal(n.scheduleTimezone,'Asia/Jakarta');
 assert.equal(fingerprintOrder(n),fingerprintOrder(normalizeWorklistOrder({...order})));
 assert.throws(()=>normalizeWorklistOrder({...order,issuerOfPatientId:''}),/issuerOfPatientId/);
 assert.throws(()=>normalizeWorklistOrder({...order,scheduledStartDate:'20260230'}),/date/);
 assert.throws(()=>normalizeWorklistOrder({...order,scheduledStartTime:'257500'}),/time/);
 assert.throws(()=>normalizeWorklistOrder({...order,scheduledStationAETitle:'OTHER AE'}),/AE/);
 assert.throws(()=>normalizeWorklistOrder({...order,scheduleTimezone:'Unknown\/Zone'}),/timezone/i);
 assert.throws(()=>normalizeWorklistOrder({...order,badField:'injected'}),/Unknown/);
 assert.throws(()=>normalizeWorklistOrder({...order,studyInstanceUID:'1.2..3'}),/UID/);
});
test('MWL sequence requires exactly one step and scopes station to calling AE',()=>{
 const good=normalizeMwlQuery({PatientID:'SYNTHETIC*',
   ScheduledProcedureStepSequence:[{
     ScheduledStationAETitle:'MWL_TEST_AE',Modality:'CR',
     ScheduledProcedureStepStartDate:'20261115-20261116'
   }]},{callingAet:'MWL_TEST_AE'});
 assert.deepEqual(good.dateBounds,['20261115','20261116']);
 assert.equal(good.Modality,'CR');
 assert.throws(()=>normalizeMwlQuery({PatientID:'X'},{callingAet:'MWL_TEST_AE'}),/Sequence/);
 assert.throws(()=>normalizeMwlQuery({ScheduledProcedureStepSequence:[
   {ScheduledStationAETitle:'OTHER_AE'}]},{callingAet:'MWL_TEST_AE'}),/calling AE/);
 assert.throws(()=>normalizeMwlQuery({ScheduledProcedureStepSequence:[
   {},{}]},{callingAet:'MWL_TEST_AE'}),/one item/);
 assert.throws(()=>normalizeMwlQuery({UnknownMatchingKey:'X',
   ScheduledProcedureStepSequence:[{}]},{callingAet:'MWL_TEST_AE'}),/Unsupported/);
});
test('MWL validates range endpoints and combines date and time ranges across midnight',()=>{
 const normalize=(date,time)=>normalizeMwlQuery({
   ScheduledProcedureStepSequence:[{
     ScheduledProcedureStepStartDate:date,
     ScheduledProcedureStepStartTime:time
   }]
 },{callingAet:'MWL_TEST_AE'});
 assert.deepEqual(normalize('20260228-20260301','2200-02').scheduleBounds,
   ['20260228220000','20260301025959']);
 assert.deepEqual(normalize('20260228-','22-').scheduleBounds,['20260228220000',null]);
 assert.deepEqual(normalize('20260228','10-11').timeBounds,['100000','115959']);
 assert.throws(()=>normalize('20260229-20260301','22-02'),/date/i);
 assert.throws(()=>normalize('20260228-20260301','1260-13'),/time/i);
 assert.throws(()=>normalize('20260228-20260301','100-13'),/time/i);
 assert.throws(()=>normalize('20260228-20260228','22-02'),/reversed schedule/i);
 assert.throws(()=>normalize('20260228','22-02'),/reversed time/i);
});
test('worklist SQL parameterizes wildcards; only scheduled rows for calling station',async()=>{
 let seen;
 const dbRow={
   patient_id:'SYNTHETIC001',issuer_of_patient_id:'RS_TEST',patient_name:'SYNTHETIC^PATIENT',
   accession_number:'ACC202611150001',accession_issuer:'RS_TEST',study_instance_uid:'2.25.12345',
   requested_procedure_id:'RP123',requested_procedure_description:'Chest radiography',
   scheduled_station_aet:'MWL_TEST_AE',modality:'CR',
   scheduled_start_date:'20261115',scheduled_start_time:'103000',
   scheduled_procedure_step_id:'SPS123',scheduled_procedure_step_description:'CHEST XRAY'
 };
 const pool={query:async(sql,args)=>{seen={sql,args};return {rows:[dbRow]};}};
 const response=await findModalityWorklist(pool,{
   PatientID:'SYNTHETIC_??',ScheduledProcedureStepSequence:[{
    Modality:'CR',ScheduledStationAETitle:'MWL_TEST_AE'
   }]
 },{callingAet:'MWL_TEST_AE'});
 assert.equal(response.length,1);
 assert.equal(response[0].PatientID,'SYNTHETIC001');
 assert.equal(response[0].IssuerOfPatientID,'RS_TEST');
 assert.deepEqual(response[0].IssuerOfAccessionNumberSequence,[{LocalNamespaceEntityID:'RS_TEST'}]);
 assert.equal(response[0].ScheduledProcedureStepSequence[0].Modality,'CR');
 assert.equal(response[0].SpecificCharacterSet,'ISO_IR 192');
 assert.ok(seen.sql.includes("status='scheduled'"));
 assert.ok(seen.sql.includes('scheduled_station_aet=$1'));
 assert.equal(seen.args[0],'MWL_TEST_AE');
 assert.ok(seen.args.includes('SYNTHETIC\\_??'.replace('??','__')));
 const huge={query:async()=>({rows:Array.from({length:51},()=>dbRow)})};
 await assert.rejects(findModalityWorklist(huge,
   {ScheduledProcedureStepSequence:[{}]},{callingAet:'MWL_TEST_AE'}),
   e=>e instanceof MwlQueryError&&e.code==='TOO_MANY_MATCHES');
});
