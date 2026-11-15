import test from 'node:test';
import assert from 'node:assert/strict';
import { element,validUID } from '../src/dicom.js';
test('DICOM UID validation',()=>{
  assert.equal(validUID('1.2.840.10008.1.2'),true);
  assert.equal(validUID('1.2..3'),false);
  assert.equal(validUID('../x'),false);
  assert.equal(validUID('9'.repeat(65)),false);
});
test('DICOM JSON patient name and numeric metadata',()=>{
  assert.deepEqual(element('PN','DOE^JANE'),{vr:'PN',Value:[{Alphabetic:'DOE^JANE'}]});
  assert.deepEqual(element('US',512),{vr:'US',Value:[512]});
});
