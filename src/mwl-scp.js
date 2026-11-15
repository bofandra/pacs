// Experimental Modality Worklist SCP — separate from Study Root Query/Retrieve.
// DICOM SOP 1.2.840.10008.5.1.4.31. Node.js owns scheduling and matching.
// Loopback + registered AE source validation. NOT FOR CLINICAL USE.
import net from 'node:net';
import dimse from 'dcmjs-dimse';
import {config} from './config.js';
import {PacsCatalog} from './catalog.js';
import {LoopbackDimseServer} from './find-scp.js';
import {findModalityWorklist,MwlQueryError} from './mwl-query.js';

const {Dataset,Scp}=dimse;
const {CFindResponse,CEchoResponse}=dimse.responses;
const {SopClass,TransferSyntax,PresentationContextResult,Status,
  RejectResult,RejectSource,RejectReason}=dimse.constants;
export const MWL_SOP_CLASS_UID='1.2.840.10008.5.1.4.31';
const syntax=new Set([TransferSyntax.ImplicitVRLittleEndian,
  TransferSyntax.ExplicitVRLittleEndian]);
const normalizedIp=ip=>(ip??'').replace(/^::ffff:/,'');
export function createMwlScpClass({catalog,peers,aet}) {
  return class NativeMwlScp extends Scp {
    associationRequested(association) {
      const calling=association.getCallingAeTitle().trim();
      const called=association.getCalledAeTitle().trim();
      if(called!==aet) {
        this.sendAssociationReject(RejectResult.Permanent,
          RejectSource.ServiceUser,RejectReason.CalledAeNotRecognized);
        return;
      }
      const peer=peers.get(calling);
      if(!peer?.enabled || peer.host!=='127.0.0.1'
        || normalizedIp(this.socket.remoteAddress)!==peer.host){
        this.sendAssociationReject(RejectResult.Permanent,
          RejectSource.ServiceUser,RejectReason.CallingAeNotRecognized);
        return;
      }
      for(const context of association.getPresentationContexts()) {
        const pc=association.getPresentationContext(context.id);
        const abstract=pc.getAbstractSyntaxUid();
        if(abstract!==SopClass.Verification && abstract!==MWL_SOP_CLASS_UID){
          pc.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
          continue;
        }
        const chosen=pc.getTransferSyntaxUids().find(s=>syntax.has(s));
        if(chosen)pc.setResult(PresentationContextResult.Accept,chosen);
        else pc.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
      }
      this.sendAssociationAccept();
    }
    cEchoRequest(request,callback) {
      const rsp=CEchoResponse.fromRequest(request);
      rsp.setStatus(Status.Success);
      callback(rsp);
    }
    async cFindRequest(request,callback) {
      const response=(status,dataset)=>{
        const r=CFindResponse.fromRequest(request);
        // CFindResponse defaults to Study Root; MWL requires the MWL SOP UID.
        r.setAffectedSopClassUid(MWL_SOP_CLASS_UID);
        r.setStatus(status);
        if(dataset)r.setDataset(new Dataset(dataset));
        return r;
      };
      try{
        if(request.getAffectedSopClassUid()!==MWL_SOP_CLASS_UID)
          throw new MwlQueryError('Incorrect MWL SOP Class');
        const calling=this.association.getCallingAeTitle().trim();
        const rows=await findModalityWorklist(catalog.pool,
          request.getDataset()?.getElements()??{}, {callingAet:calling});
        const out=rows.map(row=>response(Status.Pending,row));
        out.push(response(Status.Success));
        callback(out);
      }catch(err){
        const code=err instanceof MwlQueryError&&err.code==='TOO_MANY_MATCHES'
          ?Status.OutOfResourcesNumberOfMatches:Status.ProcessingFailure;
        // Do not log query data or clinical identifiers.
        console.warn('MWL C-FIND rejected',err instanceof MwlQueryError?err.code:
          /^[0-9A-Z]{5}$/.test(err?.code??'')?err.code:'INTERNAL');
        callback(response(code));
      }
    }
    associationReleaseRequested(){this.sendAssociationReleaseResponse();}
  };
}
export async function startMwlScp(){
  if(process.env.PACS_MWL_EXPERIMENTAL!=='1')
    throw new Error('Set PACS_MWL_EXPERIMENTAL=1 explicitly');
  const conf=config();
  const port=Number(process.env.PACS_MWL_PORT??11116);
  const aet=process.env.PACS_MWL_AET??'PACS_MWL';
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw new Error('Invalid PACS_MWL_PORT');
  if(!/^[A-Z0-9_-]{1,16}$/.test(aet))
    throw new Error('Invalid PACS_MWL_AET');
  const catalog=new PacsCatalog(conf);
  try{
    const nodes=await catalog.nodes();
    const peers=new Map(nodes.filter(n=>n.enabled&&net.isIP(n.host)===4&&n.host==='127.0.0.1')
      .map(n=>[n.aet,n]));
    const klass=createMwlScpClass({catalog,peers,aet});
    const server=new LoopbackDimseServer(klass);
    server.on('networkError',()=>console.error('MWL DIMSE network error'));
    server.listen(port,{
      associationTimeout:15000,pduTimeout:30000,
      logCommandDatasets:false,logDatasets:false
    });
    console.log('Experimental MWL SCP on 127.0.0.1:'+port+' AET='+aet);
    return {server,catalog,close:async()=>{server.close();await catalog.close();}};
  }catch(err){await catalog.close();throw err;}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const server=await startMwlScp();
  const stop=()=>server.close().finally(()=>process.exit(0));
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}
