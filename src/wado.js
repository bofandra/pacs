// Minimal WADO-RS uncompressed pixel retrieval and viewer-oriented metadata.
// Designed for synthetic CR/DX/CT/MR only. No compressed/multiframe conformance claim.
import dicomParser from 'dicom-parser';
import { validUID } from './dicom.js';

const LE_SYNTAX = new Set(['1.2.840.10008.1.2','1.2.840.10008.1.2.1']);
const tagVR = Object.freeze({
  '00080005':'CS','00080008':'CS','00080016':'UI','00080018':'UI',
  '00080020':'DA','00080021':'DA','00080022':'DA','00080023':'DA',
  '00080030':'TM','00080031':'TM','00080032':'TM','00080033':'TM',
  '00080050':'SH','00080060':'CS','00081030':'LO','0008103E':'LO',
  '00081190':'UR','00100010':'PN','00100020':'LO','00100021':'LO',
  '00100030':'DA','00100040':'CS','00180050':'DS',
  '0020000D':'UI','0020000E':'UI','00200011':'IS','00200012':'IS',
  '00200013':'IS','00200032':'DS','00200037':'DS','00200052':'UI',
  '00280002':'US','00280004':'CS','00280006':'US','00280008':'IS',
  '00280010':'US','00280011':'US','00280030':'DS','00280034':'IS',
  '00280100':'US','00280101':'US','00280102':'US','00280103':'US',
  '00281050':'DS','00281051':'DS','00281052':'DS','00281053':'DS',
  '00281054':'LO','00281055':'LO'
});
const fail=(message,statusCode=422)=>Object.assign(new Error(message),{statusCode});
function safeNumber(value) {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw fail('Unsupported pixel dimensions');
  return value;
}
function values(ds,tag,vr) {
  const key='x'+tag.toLowerCase();
  if(!ds.elements[key])return undefined;
  if(vr==='US')return [ds.uint16(key)];
  const raw=ds.string(key);
  if(raw===undefined||raw===null)return undefined;
  const trimmed=raw.replace(/\u0000+$/g,'').trim();
  if(!trimmed)return undefined;
  return trimmed.split('\\').map(x=>x.trim());
}
export function buildDicomJsonMetadata(bytes,bulkURI){
  const ds=dicomParser.parseDicom(new Uint8Array(bytes),{untilTag:'x7fe00010'});
  const result={};
  for(const [tag,vr] of Object.entries(tagVR)){
    if(tag==='00081190')continue;
    const v=values(ds,tag,vr);
    if(!v||v.some(x=>x===undefined))continue;
    result[tag]={vr,Value:vr==='PN'?v.map(x=>({Alphabetic:String(x)})):v};
  }
  if(ds.elements.x7fe00010) {
    result['7FE00010']={vr:ds.elements.x7fe00010.vr==='OB'?'OB':'OW',BulkDataURI:bulkURI};
  }
  return result;
}

export function extractUncompressedPixels(bytes,frameNumbers=null){
  if(!Buffer.isBuffer(bytes))throw fail('Expected DICOM Part 10 Buffer');
  const ds=dicomParser.parseDicom(new Uint8Array(bytes));
  const transfer=ds.string('x00020010')?.replace(/\u0000+$/g,'').trim()??'';
  if(!LE_SYNTAX.has(transfer))throw fail('Compressed or unsupported DICOM transfer syntax',415);
  const element=ds.elements.x7fe00010;
  if(!element || !Number.isSafeInteger(element.length) || element.length<1)
    throw fail('Missing or encapsulated PixelData',415);
  const rows=safeNumber(ds.uint16('x00280010'));
  const cols=safeNumber(ds.uint16('x00280011'));
  const samples=safeNumber(ds.uint16('x00280002'));
  const bits=safeNumber(ds.uint16('x00280100'));
  if(bits!==8 && bits!==16)throw fail('Only 8/16-bit uncompressed frames supported',415);
  const frameCount=Number(ds.string('x00280008')||'1');
  if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>10000)
    throw fail('Unsupported frame count',415);
  const frameSize=rows*cols*samples*(bits/8);
  if(!Number.isSafeInteger(frameSize)||frameSize<1||frameSize*frameCount>element.length)
    throw fail('Invalid PixelData dimensions');
  // DICOM may add one 0x00 byte to ensure overall even byte length.
  if(element.length>frameSize*frameCount+1)throw fail('PixelData length inconsistent with geometry');
  if(frameNumbers===null) {
    return {buffer:bytes.subarray(element.dataOffset,element.dataOffset+element.length),
      count:frameCount,frameSize};
  }
  if(!Array.isArray(frameNumbers)||!frameNumbers.length||frameNumbers.length>100)
    throw fail('Invalid frame selection',400);
  const frames=[];
  for(const frame of frameNumbers){
    if(!Number.isSafeInteger(frame)||frame<1||frame>frameCount)
      throw fail('Requested frame outside instance',404);
    const start=element.dataOffset+(frame-1)*frameSize;
    frames.push({number:frame,bytes:bytes.subarray(start,start+frameSize)});
  }
  return {frames,count:frameCount,frameSize};
}
export function parseFrameList(spec) {
  if(typeof spec!=='string'||!/^[0-9]+(?:,[0-9]+)*$/.test(spec)||spec.length>400)
    throw fail('Invalid frame list',400);
  const frames=spec.split(',').map(Number);
  if(frames.length>100||frames.some(n=>!Number.isSafeInteger(n)||n<=0))
    throw fail('Too many or invalid frame numbers',400);
  return frames;
}
export function makeBulkMultipart(parts,baseURI,boundary){
  if(!/^[A-Za-z0-9_-]+$/.test(boundary))throw fail('Invalid multipart boundary',400);
  const chunks=[];
  for(const part of parts){
    chunks.push(Buffer.from(
      '--'+boundary+'\r\nContent-Type: application/octet-stream\r\n'+
      'Content-Location: '+baseURI+(part.number?'/frames/'+part.number:'')+
      '\r\n\r\n','ascii'));
    chunks.push(part.bytes);
    chunks.push(Buffer.from('\r\n','ascii'));
  }
  chunks.push(Buffer.from('--'+boundary+'--\r\n','ascii'));
  return {
    type:'multipart/related; type="application/octet-stream"; boundary="'+boundary+'"',
    buffer:Buffer.concat(chunks)
  };
}
export function validateDicomPath(...uids) {
  if(!uids.every(validUID))throw fail('Invalid DICOM UID',400);
}
