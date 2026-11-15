import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoute } from '../src/routing.js';
import { safeDeliveryError } from '../src/delivery-worker.js';

test('routing rules reject invalid peer AE and modality values',()=>{
  assert.deepEqual(validateRoute({destinationAet:'TEST_SCP',modality:'CR',enabled:false}),
    {destinationAet:'TEST_SCP',modality:'CR',enabled:false});
  assert.throws(()=>validateRoute({destinationAet:'bad host/path',enabled:true}),/AE title/);
  assert.throws(()=>validateRoute({destinationAet:'TEST_SCP',modality:'../../secret'}),/modality/);
  assert.throws(()=>validateRoute({destinationAet:'TEST_SCP',enabled:'yes'}),/boolean/);
});
test('delivery failures only persist generic error codes without PHI',()=>{
  const leak=new Error('Patient^NAME 12345');
  assert.equal(safeDeliveryError(leak),'DELIVERY_FAILED');
  assert.equal(safeDeliveryError({code:'DIMSE_TIMEOUT'}),'DIMSE_TIMEOUT');
});
