import dicomParser from 'dicom-parser';

const TAGS = {
  '00080016': ['SOPClassUID','UI'], '00080018': ['SOPInstanceUID','UI'],
  '00080020': ['StudyDate','DA'], '00080030': ['StudyTime','TM'],
  '00080050': ['AccessionNumber','SH'], '00080060': ['Modality','CS'],
  '00081030': ['StudyDescription','LO'], '00100010': ['PatientName','PN'],
  '00100020': ['PatientID','LO'], '0020000D': ['StudyInstanceUID','UI'],
  '0020000E': ['SeriesInstanceUID','UI'], '00200011': ['SeriesNumber','IS'],
  '00200013': ['InstanceNumber','IS'], '00280002': ['SamplesPerPixel','US'],
  '00280004': ['PhotometricInterpretation','CS'], '00280008': ['NumberOfFrames','IS'],
  '00280010': ['Rows','US'], '00280011': ['Columns','US'],
  '00280100': ['BitsAllocated','US'], '00280101': ['BitsStored','US'],
  '00280102': ['HighBit','US'], '00280103': ['PixelRepresentation','US']
};
const UID_RE = /^[0-9]+(?:\.[0-9]+)*$/;
export function validUID(value) {
  return typeof value === 'string' && value.length <= 64 && UID_RE.test(value);
}
export function element(vr, value) {
  if (value === undefined || value === null || value === '') return { vr };
  if (vr === 'PN') return { vr, Value: [{ Alphabetic: String(value) }] };
  if (vr === 'IS' || vr === 'US') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? { vr, Value: [n] } : { vr };
  }
  return { vr, Value: [String(value)] };
}
export function parseDicom(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 132 || buffer.toString('ascii', 128, 132) !== 'DICM')
    throw new Error('Expected a DICOM Part 10 file with DICM marker');
  let ds;
  try {
    // Stop before PixelData to avoid traversing large encapsulated payloads.
    ds = dicomParser.parseDicom(new Uint8Array(buffer), { untilTag: 'x7fe00010' });
  } catch (error) { throw new Error(`Unable to parse DICOM: ${error.message}`); }
  const get = tag => (ds.string('x' + tag) ?? '').trim();
  const meta = {};
  for (const [tag, [,vr]] of Object.entries(TAGS)) {
    const binary = vr === 'US' ? ds.uint16('x' + tag) : undefined;
    const value = binary ?? get(tag);
    if (value !== '') meta[tag] = element(vr, value);
  }
  const transferSyntax = get('00020010');
  if (transferSyntax) meta['00020010'] = element('UI', transferSyntax);
  const studyUID = get('0020000D');
  const seriesUID = get('0020000E');
  const instanceUID = get('00080018');
  const sopClassUID = get('00080016');
  if (![studyUID, seriesUID, instanceUID, sopClassUID].every(validUID))
    throw new Error('Missing or invalid Study/Series/SOP Instance/SOP Class UID');
  return {
    studyUID, seriesUID, instanceUID, sopClassUID,
    transferSyntax: transferSyntax || '1.2.840.10008.1.2',
    patientId: get('00100020'),
    patientName: get('00100010'),
    accession: get('00080050'),
    studyDate: get('00080020'),
    studyDescription: get('00081030'),
    modality: get('00080060'),
    seriesNumber: get('00200011'),
    metadata: meta
  };
}
// Metadata currently includes a selected subset of attributes only.
// Do not advertise a BulkDataURI until frame / pixel retrieval is implemented.
export function withBulkDataUri(metadata) {
  return structuredClone(metadata);
}
