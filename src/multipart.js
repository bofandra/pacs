export function parseDicomMultipart(contentType, body, maxParts = 100) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary || boundary.length > 70 || !/^[\x21-\x7e]+$/.test(boundary))
    throw new Error('Missing or invalid multipart boundary');
  if (!Buffer.isBuffer(body)) throw new Error('Expected a multipart binary payload');
  const marker = Buffer.from('--' + boundary, 'ascii');
  const separator = Buffer.from('\r\n--' + boundary, 'ascii');
  if (body.indexOf(marker) !== 0) throw new Error('Invalid multipart opening boundary');
  let pos = marker.length;
  const parts = [];
  while (pos < body.length) {
    if (body.subarray(pos, pos+2).toString() === '--') return parts;
    if (body.subarray(pos, pos+2).toString() !== '\r\n') throw new Error('Invalid MIME delimiter');
    pos += 2;
    const endHeaders = body.indexOf('\r\n\r\n', pos, 'ascii');
    if (endHeaders < 0 || endHeaders - pos > 16384) throw new Error('Invalid MIME headers');
    const headers = body.subarray(pos, endHeaders).toString('ascii');
    if (!/^content-type:\s*application\/dicom\s*$/im.test(headers))
      throw new Error('Each STOW part must have Content-Type: application/dicom');
    pos = endHeaders + 4;
    const next = body.indexOf(separator, pos);
    if (next < 0 || next === pos) throw new Error('Missing MIME boundary or empty DICOM part');
    parts.push(body.subarray(pos, next));
    if (parts.length > maxParts) throw new Error('Too many DICOM objects in one STOW request');
    pos = next + separator.length;
  }
  throw new Error('Unterminated multipart body');
}
export function buildDicomMultipart(payload, boundary = 'pacs-' + Math.random().toString(16).slice(2)) {
  const header = Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`, 'ascii');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii');
  return { type: `multipart/related; type="application/dicom"; boundary="${boundary}"`, data: Buffer.concat([header, payload, footer]) };
}
