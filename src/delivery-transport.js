import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function sendDicomNative({conf,node,sourcePath,timeoutMs=90000}) {
  if(!node || !node.enabled) throw Object.assign(new Error('AE disabled'),{code:'AE_DISABLED'});
  const executable=fileURLToPath(new URL('./native-store-child.js',import.meta.url));
  return await new Promise((resolve,reject)=>{
    let settled=false;
    const child=fork(executable,[],{
      execArgv:[],
      stdio:['ignore','ignore','ignore','ipc']
    });
    const finish=(ok,code)=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      child.kill();
      if(ok) resolve({status:'success'});
      else reject(Object.assign(new Error('DIMSE store operation did not complete'),{code}));
    };
    const timer=setTimeout(()=>finish(false,'DIMSE_TIMEOUT'),timeoutMs);
    child.on('error',()=>finish(false,'DIMSE_PROCESS_ERROR'));
    child.on('exit',code=>{if(!settled) finish(false,'DIMSE_PROCESS_ERROR');});
    child.on('message',msg=>{
      if(msg?.type==='result') finish(msg.ok===true,msg.ok===true?null:'DIMSE_ASSOCIATION_FAILED');
    });
    child.send({
      source:{aet:conf.aet,ip:conf.dicomIp,port:conf.sourcePort},
      target:{aet:node.aet,ip:node.host,port:node.port},
      sourcePath
    },error=>{if(error) finish(false,'DIMSE_PROCESS_ERROR');});
  });
}
