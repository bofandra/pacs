import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFrameList,makeBulkMultipart,validateDicomPath} from '../src/wado.js';

test('WADO frame selector rejects invalid, excessive and out-of-range syntax',()=>{
  assert.deepEqual(parseFrameList('1,2,10'),[1,2,10]);
  assert.throws(()=>parseFrameList('../1'),/Invalid frame list/);
  assert.throws(()=>parseFrameList('1,,2'),/Invalid frame list/);
  assert.throws(()=>parseFrameList('0'),/invalid frame numbers/i);
  assert.throws(()=>parseFrameList('1'.repeat(401)),/Invalid frame list/);
  assert.throws(()=>parseFrameList(Array(101).fill('1').join(',')),/Too many/);
  assert.doesNotThrow(()=>validateDicomPath('1.2.3','2.3.4','3.4.5'));
  assert.throws(()=>validateDicomPath('1.2.3','../study','1.2.5'),/Invalid DICOM UID/);
});
test('WADO MIME frame payload preserves exact bytes and location',()=>{
  const payload=Buffer.from([0x00,0xff,0x64,0x00]);
  const result=makeBulkMultipart([{number:1,bytes:payload}],'/dicomweb/instances/2.25.1','test_boundary');
  assert.match(result.type,/multipart\/related/);
  const encoded=Buffer.from(result.buffer);
  assert.ok(encoded.indexOf(payload)>=0);
  assert.match(encoded.toString('latin1'),/Content-Location: \/dicomweb\/instances\/2\.25\.1\/frames\/1/);
  assert.match(encoded.toString('latin1'),/--test_boundary--/);
  assert.throws(()=>makeBulkMultipart([],'.','evil\r\nHeader'),/boundary/);
});
