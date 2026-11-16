import dimse from 'dcmjs-dimse';

const {Client}=dimse;
const {CStoreRequest}=dimse.requests;
const {Status}=dimse.constants;

export async function sendStoreFile({node,aet,sourcePath,timeoutMs}) {
  const client=new Client();
  const request=new CStoreRequest(sourcePath);
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(errorCode)=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      try{client.network?.close();}catch{}
      if(errorCode)reject(Object.assign(new Error(errorCode),{code:errorCode}));
      else resolve({status:'success'});
    };
    const timer=setTimeout(()=>finish('STORE_TIMEOUT'),timeoutMs);
    request.on('response',response=>{
      finish(response.getStatus()===Status.Success?null:'STORE_RESPONSE_FAILURE');
    });
    client.on('associationRejected',()=>finish('STORE_ASSOCIATION_REJECTED'));
    client.on('networkError',()=>finish('STORE_NETWORK_ERROR'));
    client.on('closed',()=>finish('STORE_CLOSED_PREMATURELY'));
    try{
      client.addRequest(request);
      client.send(node.host,node.port,aet,node.aet,{
        connectTimeout:Math.min(timeoutMs,10000),
        associationTimeout:Math.min(timeoutMs,10000),
        pduTimeout:Math.min(timeoutMs,10000),
        logCommandDatasets:false,logDatasets:false
      });
    }catch{finish('STORE_SEND_FAILED');}
  });
}
