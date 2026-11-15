// Experimental Study Root C-FIND SCP using dcmjs-dimse and the PACS PostgreSQL catalog.
// Explicit opt-in, loopback-only listener. Not for patient data or clinical use.
import net from 'node:net';
import dimsePackage from 'dcmjs-dimse';
import { config } from './config.js';
import { PacsCatalog } from './catalog.js';
import { findStudyRoot, FindQueryError } from './find-query.js';

const { Dataset, Scp, Server }=dimsePackage;
const { CEchoResponse, CFindResponse }=dimsePackage.responses;
const { Status, SopClass, TransferSyntax, PresentationContextResult,
  RejectResult,RejectSource,RejectReason }=dimsePackage.constants;
const supportedSyntaxes=new Set([
  TransferSyntax.ImplicitVRLittleEndian,TransferSyntax.ExplicitVRLittleEndian
]);
const sanitizeIP = address => (address||'').replace(/^::ffff:/,'');
function matchPeer(peers,called,calling,ip,ownAet) {
  if(called!==ownAet) return {ok:false,reason:RejectReason.CalledAeNotRecognized};
  const peer=peers.get(calling);
  if(!peer || !peer.enabled || sanitizeIP(peer.host)!==sanitizeIP(ip))
    return {ok:false,reason:RejectReason.CallingAeNotRecognized};
  return {ok:true};
}
export function createFindScpClass({catalog,peers,aet}) {
  return class PacsFindScp extends Scp {
    associationRequested(association) {
      const called=association.getCalledAeTitle().trim();
      const calling=association.getCallingAeTitle().trim();
      const decision=matchPeer(peers,called,calling,this.socket.remoteAddress,aet);
      if(!decision.ok) {
        this.sendAssociationReject(RejectResult.Permanent,RejectSource.ServiceUser,decision.reason);
        return;
      }
      for(const proposed of association.getPresentationContexts()){
        const ctx=association.getPresentationContext(proposed.id);
        const abstract=ctx.getAbstractSyntaxUid();
        if(abstract!==SopClass.Verification &&
           abstract!==SopClass.StudyRootQueryRetrieveInformationModelFind) {
          ctx.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
          continue;
        }
        const syntax=ctx.getTransferSyntaxUids().find(x=>supportedSyntaxes.has(x));
        if(syntax) ctx.setResult(PresentationContextResult.Accept,syntax);
        else ctx.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
      }
      this.sendAssociationAccept();
    }
    cEchoRequest(request,callback) {
      const response=CEchoResponse.fromRequest(request);
      response.setStatus(Status.Success);
      callback(response);
    }
    async cFindRequest(request,callback) {
      try {
        const dataset=request.getDataset()?.getElements() ?? {};
        const rows=await findStudyRoot(catalog.pool,dataset);
        const responses=rows.map(row=>{
          const response=CFindResponse.fromRequest(request);
          response.setStatus(Status.Pending);
          response.setDataset(new Dataset(row));
          return response;
        });
        const complete=CFindResponse.fromRequest(request);
        complete.setStatus(Status.Success);
        responses.push(complete);
        callback(responses);
      } catch(error) {
        // Never log patient identifiers or raw datasets; numeric database codes only.
        console.warn('C-FIND rejected',error instanceof FindQueryError?error.code:
          /^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:'INTERNAL');
        const response=CFindResponse.fromRequest(request);
        response.setStatus(error instanceof FindQueryError && error.code==='TOO_MANY_RESULTS'
          ?Status.OutOfResourcesNumberOfMatches:Status.ProcessingFailure);
        response.setErrorComment('C-FIND query rejected or unavailable');
        callback(response);
      }
    }
    // C-MOVE/C-GET presentation contexts are intentionally rejected until correct
    // C-STORE suboperations, response counters and association role negotiation exist.
    associationReleaseRequested(){this.sendAssociationReleaseResponse();}
  };
}
// dcmjs-dimse Server.listen() does not expose a host binding argument.
// Override only its transport binding to avoid accidentally listening on 0.0.0.0.
export class LoopbackDimseServer extends Server {
  listen(port,opts={}) {
    this.server=net.createServer(socket=>{
      const client=new this.scp.class(socket,opts);
      client.connected=true;
      client.on('close',()=>{this.statistics.addFromOtherStatistics(client.getStatistics());});
      client.on('networkError',()=>{client.close();});
      this.clients.push(client);
      this.clients=this.clients.filter(item=>item.connected);
    });
    this.server.on('listening',()=>this.emit('listening'));
    this.server.on('error',err=>this.emit('networkError',err));
    this.server.listen(port,'127.0.0.1');
  }
}
export async function startFindScp() {
  if(process.env.PACS_FIND_EXPERIMENTAL!=='1')
    throw new Error('PACS_FIND_EXPERIMENTAL=1 must be set explicitly');
  const conf=config();
  const port=Number(process.env.PACS_FIND_PORT??11115);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid PACS_FIND_PORT');
  if(!/^[A-Z0-9_-]{1,16}$/.test(conf.aet)) throw new Error('Invalid PACS_AET');
  const catalog=new PacsCatalog(conf);
  try {
    const nodes=await catalog.nodes();
    const peers=new Map(nodes.filter(n=>n.enabled && net.isIP(n.host)===4)
      .map(n=>[n.aet,n]));
    const Klass=createFindScpClass({catalog,peers,aet:conf.aet});
    const server=new LoopbackDimseServer(Klass);
    server.on('networkError',()=>{console.error('DICOM C-FIND SCP network error');});
    server.listen(port,{associationTimeout:15000,pduTimeout:30000,logCommandDatasets:false,logDatasets:false});
    console.log('Experimental C-FIND SCP listening at 127.0.0.1:'+port+' with '+peers.size+' enabled AE peers');
    const close=async()=>{server.close();await catalog.close();};
    return {server,catalog,close};
  } catch(error) {await catalog.close();throw error;}
}
if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href) {
  const instance=await startFindScp();
  const shutdown=()=>instance.close().finally(()=>process.exit(0));
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
}
