import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDicomMultipart,parseDicomMultipart } from '../src/multipart.js';
test('multipart/related round-trip preserves binary DICOM bytes',()=>{
  const source=Buffer.from([0,1,2,3,10,13,255,0,128]);
  const encoded=buildDicomMultipart(source,'test-boundary');
  const parsed=parseDicomMultipart(encoded.type,encoded.data);
  assert.equal(parsed.length,1);
  assert.deepEqual(parsed[0],source);
});
test('reject missing boundary, invalid content type and truncated body',()=>{
  const {data,type}=buildDicomMultipart(Buffer.from('abc'),'xyz');
  assert.throws(()=>parseDicomMultipart('multipart/related',data),/boundary/);
  assert.throws(()=>parseDicomMultipart(type,data.subarray(0,25)),/MIME|boundary/);
  const wrong=Buffer.from('--xyz\r\nContent-Type: text/plain\r\n\r\nhello\r\n--xyz--\r\n');
  assert.throws(()=>parseDicomMultipart(type,wrong),/application\/dicom/);
});
