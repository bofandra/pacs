import {createReadStream} from 'node:fs';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import {config} from './config.js';

const mediaTypes={
  '.css':'text/css',
  '.html':'text/html',
  '.ico':'image/x-icon',
  '.js':'text/javascript',
  '.json':'application/json',
  '.png':'image/png',
  '.svg':'image/svg+xml',
  '.wasm':'application/wasm',
  '.woff':'font/woff',
  '.woff2':'font/woff2'
};

if(process.env.PACS_OHIF_EXPERIMENTAL!=='1'||!process.env.PACS_OHIF_DIST)
  throw new Error('Set PACS_OHIF_EXPERIMENTAL=1 and PACS_OHIF_DIST to the OHIF dist directory');
const conf=config();
if(!conf.token||conf.token.length<20)throw new Error('Set the PACS development API_TOKEN');
const port=Number(process.env.PACS_OHIF_PORT??3400);
if(!Number.isInteger(port)||port<1024||port>65535||port===conf.port)
  throw new Error('Invalid PACS_OHIF_PORT');
const dist=await realpath(process.env.PACS_OHIF_DIST);
if(!(await stat(path.join(dist,'index.html'))).isFile())
  throw new Error('OHIF dist directory must contain index.html');
const clientConfig=await readFile(new URL('../docs/ohif-app-config.js',import.meta.url));
const origin='http://127.0.0.1:'+port;
const pacsOrigin='http://127.0.0.1:'+conf.port;
const app=Fastify();

app.addHook('onRequest',async(req,reply)=>{
  if(req.headers.host!=='127.0.0.1:'+port ||
     (req.headers.origin && req.headers.origin!==origin) ||
     req.headers['sec-fetch-site']==='cross-site')
    return reply.code(403).send({error:'Open the viewer on '+origin});
  reply.header('Cross-Origin-Opener-Policy','same-origin');
  reply.header('Cross-Origin-Embedder-Policy','require-corp');
  reply.header('Cross-Origin-Resource-Policy','same-origin');
});

async function proxyDicomweb(req,reply) {
  const target=new URL(req.url,pacsOrigin);
  if(target.origin!==pacsOrigin ||
     (target.pathname!=='/dicomweb/studies'&&!target.pathname.startsWith('/dicomweb/studies/')))
    return reply.code(404).send({error:'Not found'});
  const headers={Authorization:'Bearer '+conf.token};
  if(req.headers.accept)headers.Accept=req.headers.accept;
  reply.header('Cache-Control','no-store');
  try {
    const response=await fetch(target,{
      method:req.method,headers,redirect:'error',signal:AbortSignal.timeout(30000)
    });
    const type=response.headers.get('content-type');
    if(type)reply.type(type);
    return reply.code(response.status).send(response.body);
  }catch{
    return reply.code(502).send({error:'PACS DICOMweb unavailable'});
  }
}
app.get('/dicomweb/studies',proxyDicomweb);
app.get('/dicomweb/studies/*',proxyDicomweb);
app.get('/app-config.js',async(_req,reply)=>reply.type('text/javascript').send(clientConfig));

async function sendAsset(relative,reply) {
  const requested=path.resolve(dist,relative);
  if(!requested.startsWith(dist+path.sep))return reply.code(404).send();
  const file=await realpath(requested).catch(()=>null);
  if(!file?.startsWith(dist+path.sep)||!(await stat(file).catch(()=>null))?.isFile())
    return reply.code(404).send();
  return reply.type(mediaTypes[path.extname(file)]??'application/octet-stream').send(createReadStream(file));
}
app.get('/',async(_req,reply)=>sendAsset('index.html',reply));
app.get('/viewer',async(_req,reply)=>sendAsset('index.html',reply));
app.get('/*',async(req,reply)=>sendAsset(req.params['*'],reply));

async function stop(){await app.close();}
process.once('SIGINT',stop);
process.once('SIGTERM',stop);
await app.listen({host:'127.0.0.1',port});
console.log('Synthetic OHIF viewer available at '+origin);
