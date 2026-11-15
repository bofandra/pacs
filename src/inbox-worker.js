import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { PacsCatalog } from './catalog.js';

const conf = config();
const catalog = new PacsCatalog(conf);
const incoming = path.join(conf.inboxRoot,'incoming');
await fs.mkdir(incoming,{recursive:true});
async function* filesIn(dir) {
  for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if (entry.isDirectory()) yield* filesIn(full);
    else if(entry.isFile() && !entry.name.startsWith('.')) yield full;
  }
}
let busy=false;
async function scan() {
  if (busy) return;
  busy=true;
  try {
    for await (const file of filesIn(incoming)) {
      const stat=await fs.stat(file).catch(()=>null);
      if (!stat || !stat.size || Date.now()-stat.mtimeMs<5000) continue;
      try {
        const bytes=await fs.readFile(file);
        const outcome=await catalog.ingest(bytes);
        console.log('[INDEX]',outcome.status,outcome.instanceUID);
        await fs.unlink(file); // only after the original is content-addressed and indexed
      } catch(error) {
        console.error('[INDEX ERROR] retained for inspection:',file,error.message);
      }
    }
  } finally {busy=false;}
}
process.on('SIGTERM',async()=>{clearInterval(timer);await catalog.close();process.exit(0);});
const timer=setInterval(()=>scan().catch(console.error),3000);
await scan();
console.log('Inbox indexer monitoring',incoming);
