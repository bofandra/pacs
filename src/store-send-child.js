import { sendStoreFile } from './store-transfer.js';

function report(ok) {
  if(process.send)process.send({type:'result',ok},()=>process.exit(ok?0:1));
  else process.exit(ok?0:1);
}

process.once('message',async payload=>{
  try {
    await sendStoreFile(payload);
    report(true);
  }catch{report(false);}
});
process.once('uncaughtException',()=>report(false));
process.once('unhandledRejection',()=>report(false));
