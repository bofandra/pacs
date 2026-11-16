import fs from 'node:fs/promises';
import { config } from './config.js';
import { PacsCatalog } from './catalog.js';
import { nativeDicom } from './dimse.js';
const conf = config();
const catalog = new PacsCatalog(conf);
try {
  const native = await nativeDicom();
  await fs.mkdir(conf.inboxRoot + '/incoming', {recursive:true});
  const peers = (await catalog.nodes()).filter(n=>n.enabled).map(n=>({aet:n.aet,ip:n.host,port:n.port}));
  console.log(`Starting DICOM C-STORE/C-ECHO listener on ${conf.dicomIp}:${conf.dicomPort}, AE ${conf.aet}`);
  native.startStoreScp({
    source: { aet:conf.aet,ip:conf.dicomIp,port:conf.dicomPort },
    peers,
    storagePath: conf.inboxRoot + '/incoming'
  }, result => console.log('[DIMSE]',result));
  // The native addon owns the listener lifecycle; run 'npm run worker' independently
  // to index files received in the inbox. Network and AE filtering require validation.
} catch(err) {
  console.error('Cannot start DIMSE SCP:',err);
  process.exitCode=1;
} finally {
  await catalog.close();
}
