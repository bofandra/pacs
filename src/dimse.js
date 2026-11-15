import { config } from './config.js';
import fs from 'node:fs/promises';

export async function nativeDicom() {
  try {
    const imported = await import('dicom-dimse-native');
    return imported.default ?? imported;
  } catch (err) {
    throw Object.assign(new Error('DIMSE native addon unavailable; install optional dicom-dimse-native and verify supported platform'), {cause:err,statusCode:503});
  }
}

export async function runDimse(catalog, mode, input) {
  const conf = config();
  const node = await catalog.node(input.aet);
  if (!node) throw Object.assign(new Error('Target AE not registered or disabled'), {statusCode:404});
  const native = await nativeDicom();
  const method = { find: 'findScu', move: 'moveScu', get: 'getScu' }[mode];
  if (!method || typeof native[method] !== 'function') throw Object.assign(new Error('DIMSE operation unsupported'), {statusCode:501});
  const uid = input.studyUID;
  if (!uid || !/^[0-9]+(?:\.[0-9]+)*$/.test(uid) || uid.length>64)
    throw Object.assign(new Error('A valid studyUID is required'), {statusCode:400});
  const options = {
    source: { aet: conf.aet, ip: conf.dicomIp, port: conf.sourcePort },
    target: { aet: node.aet, ip: node.host, port: node.port },
    tags: [ {key:'00080052',value:'STUDY'}, {key:'0020000D',value:uid} ],
    verbose: false
  };
  if (mode==='move') options.destination = conf.aet;
  if (mode==='get') {
    await fs.mkdir(conf.inboxRoot + '/incoming', {recursive:true});
    options.storagePath = conf.inboxRoot + '/incoming';
  }
  return await new Promise((resolve,reject)=>{
    const events = [];
    const timer = setTimeout(()=>reject(Object.assign(new Error('DIMSE request timed out'),{statusCode:504})),30000);
    try {
      native[method](options, message => {
        let event;
        try { event = JSON.parse(message); } catch { event = { message: String(message) }; }
        events.push(event);
        if (events.length>1000) {clearTimeout(timer);return reject(new Error('Too many DIMSE events'));}
        if (event.status === 'success' || event.code === 0) {
          clearTimeout(timer);
          resolve({operation:mode,target:node.aet,events});
        } else if (event.status === 'failure' || event.code === 2) {
          clearTimeout(timer);
          reject(Object.assign(new Error(event.message ?? 'DIMSE service failed'),{statusCode:502}));
        }
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
