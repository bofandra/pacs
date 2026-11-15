// Isolate the optional native DIMSE addon in a child process: a stalled
// association must not block the HTTP server or the job scheduler.
import { nativeDicom } from './dimse.js';

let responded=false;
function report(ok) {
  if (responded) return;
  responded=true;
  if (process.send) process.send({type:'result',ok},()=>process.exit(ok?0:1));
  else process.exit(ok?0:1);
}
process.once('message',async(payload)=>{
  try {
    if(!payload || !payload.source || !payload.target || !payload.sourcePath) throw new Error('Invalid DIMSE send arguments');
    const native=await nativeDicom();
    if(typeof native.storeScu!=='function') throw new Error('Native C-STORE SCU unavailable');
    native.storeScu({
      source:payload.source,
      target:payload.target,
      sourcePath:payload.sourcePath,
      verbose:false
    },raw=>{
      let event;
      try {event=typeof raw==='string'?JSON.parse(raw):raw;} catch {event={};}
      if(event?.status==='success'||event?.code===0) report(true);
      else if(event?.status==='failure'||event?.code===2) report(false);
    });
  } catch {report(false);}
});
process.on('uncaughtException',()=>report(false));
process.on('unhandledRejection',()=>report(false));
