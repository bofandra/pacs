// Development-only inbound C-ECHO/C-STORE SCP using JavaScript DIMSE.
// Stores a reconstructed DICOM Part 10 representation of the received DIMSE
// dataset. The original on-wire DIMSE payload is NOT a Part 10 file.
// A C-STORE Success is sent only AFTER durable catalog.ingest() commits.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dimse from 'dcmjs-dimse';
import { config } from './config.js';
import { PacsCatalog } from './catalog.js';
import { LoopbackDimseServer } from './find-scp.js';
import { validUID } from './dicom.js';

const { Scp } = dimse;
const { CEchoResponse, CStoreResponse } = dimse.responses;
const { SopClass, TransferSyntax, PresentationContextResult, Status,
  RejectResult, RejectSource, RejectReason } = dimse.constants;
const supportedStorage = new Set([
  '1.2.840.10008.5.1.4.1.1.1',    // CR
  '1.2.840.10008.5.1.4.1.1.1.1',  // DX
  '1.2.840.10008.5.1.4.1.1.2',    // CT
  '1.2.840.10008.5.1.4.1.1.4'     // MR
]);
const syntaxes = new Set([
  TransferSyntax.ImplicitVRLittleEndian,
  TransferSyntax.ExplicitVRLittleEndian
]);
const sanitizeIP = ip => (ip ?? '').replace(/^::ffff:/,'');
const STORE_CANNOT_PROCESS = 0xC000;
const STORE_OUT_OF_RESOURCES = 0xA700;

export function createStoreScpClass({catalog,peers,aet,maxBytes=67108864}) {
  return class NativeJsStoreScp extends Scp {
    associationRequested(association) {
      const called=association.getCalledAeTitle().trim();
      const calling=association.getCallingAeTitle().trim();
      const peer=peers.get(calling);
      if(called!==aet) {
        this.sendAssociationReject(RejectResult.Permanent,
          RejectSource.ServiceUser,RejectReason.CalledAeNotRecognized);
        return;
      }
      if(!peer?.enabled || peer.host!=='127.0.0.1' ||
         sanitizeIP(this.socket.remoteAddress)!==peer.host) {
        this.sendAssociationReject(RejectResult.Permanent,
          RejectSource.ServiceUser,RejectReason.CallingAeNotRecognized);
        return;
      }
      for(const p of association.getPresentationContexts()) {
        const context=association.getPresentationContext(p.id);
        const sop=context.getAbstractSyntaxUid();
        if(sop!==SopClass.Verification&&!supportedStorage.has(sop)){
          context.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
          continue;
        }
        const accepted=context.getTransferSyntaxUids().find(x=>syntaxes.has(x));
        if(accepted)context.setResult(PresentationContextResult.Accept,accepted);
        else context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
      }
      this.sendAssociationAccept();
    }
    cEchoRequest(request,callback) {
      const rsp=CEchoResponse.fromRequest(request);
      rsp.setStatus(Status.Success);
      callback(rsp);
    }
    async cStoreRequest(request,callback) {
      const rsp=CStoreResponse.fromRequest(request);
      let tmp=null;
      try {
        const dataset=request.getDataset();
        if(!dataset)throw Object.assign(new Error('Missing dataset'),{statusCode:400});
        const commandSopClass=request.getAffectedSopClassUid();
        const commandSopUID=request.getAffectedSopInstanceUid();
        const datasetSopClass=dataset.getElement('SOPClassUID');
        const datasetSopUID=dataset.getElement('SOPInstanceUID');
        if(!supportedStorage.has(commandSopClass) ||
           !syntaxes.has(dataset.getTransferSyntaxUid()) ||
           !validUID(commandSopUID) || commandSopUID!==datasetSopUID ||
           commandSopClass!==datasetSopClass)
          throw Object.assign(new Error('Command/dataset SOP UID mismatch'),{statusCode:400});
        tmp=await fs.mkdtemp(path.join(os.tmpdir(),'pacs-dimse-store-'));
        const file=path.join(tmp,'received.dcm');
        // Convert received DIMSE dataset to Part 10 for content-addressed archiving.
        // No claim to preserve byte-for-byte on-wire DIMSE representation.
        await new Promise((resolve,reject)=>{
          dataset.toFile(file,error=>error?reject(error):resolve());
        });
        const stat=await fs.stat(file);
        if(stat.size===0 || stat.size>maxBytes)
          throw Object.assign(new Error('DIMSE object over maximum size'),{statusCode:413});
        const bytes=await fs.readFile(file);
        const stored=await catalog.ingest(bytes); // checksum, atomic storage, DB transaction
        if(!['stored','duplicate'].includes(stored.status))
          throw new Error('Unexpected ingest outcome');
        rsp.setStatus(Status.Success);
      }catch(error){
        // Never report success for a corrupt object, UID collision or DB failure.
        rsp.setStatus(error?.statusCode===413?STORE_OUT_OF_RESOURCES:STORE_CANNOT_PROCESS);
        console.warn('C-STORE rejected',error?.statusCode===409?'UID_CONFLICT':
          error?.statusCode===413?'RESOURCE_LIMIT':'INGEST_ERROR');
      }finally{
        if(tmp)await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});
        callback(rsp);
      }
    }
    associationReleaseRequested(){this.sendAssociationReleaseResponse();}
  };
}
export async function startStoreScp(){
  if(process.env.PACS_STORE_EXPERIMENTAL!=='1')
    throw new Error('Set PACS_STORE_EXPERIMENTAL=1 explicitly');
  const conf=config();
  const port=Number(process.env.PACS_STORE_PORT??11112);
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw new Error('Invalid PACS_STORE_PORT');
  if(!/^[A-Z0-9_-]{1,16}$/.test(conf.aet))
    throw new Error('Invalid PACS_AET');
  const catalog=new PacsCatalog(conf);
  try{
    const peers=new Map((await catalog.nodes())
      .filter(n=>n.enabled&&net.isIP(n.host)===4&&n.host==='127.0.0.1')
      .map(n=>[n.aet,n]));
    const scp=createStoreScpClass({catalog,peers,aet:conf.aet,maxBytes:conf.maxBytes});
    const server=new LoopbackDimseServer(scp);
    server.on('networkError',()=>console.error('DICOM C-STORE SCP network error'));
    server.listen(port,{associationTimeout:15000,pduTimeout:30000,
      logCommandDatasets:false,logDatasets:false});
    console.log('Experimental C-ECHO/C-STORE SCP listening on 127.0.0.1:'+port);
    return {server,catalog,close:async()=>{server.close();await catalog.close();}};
  }catch(error){await catalog.close();throw error;}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+path.resolve(process.argv[1])).href){
  const instance=await startStoreScp();
  const close=()=>instance.close().finally(()=>process.exit(0));
  process.once('SIGTERM',close);
  process.once('SIGINT',close);
}
