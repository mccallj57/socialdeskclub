import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Writes } from "./core.mjs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
class DynamoStore {
  constructor(table){this.table=table;}
  async get(pk,sk){
    const {Item}=await ddb.send(new GetCommand({TableName:this.table,Key:{pk,sk},ConsistentRead:true}));
    return Item?JSON.parse(Item.payload):null;
  }
  async list(pk,prefix){
    let cursor,rows=[];
    do{
      const out=await ddb.send(new QueryCommand({TableName:this.table,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":pk,":prefix":prefix},ConsistentRead:true,ExclusiveStartKey:cursor}));
      rows.push(...(out.Items||[]).map(i=>JSON.parse(i.payload)));cursor=out.LastEvaluatedKey;
    }while(cursor);
    return rows;
  }
  async commit(ops){
    try{
      await ddb.send(new TransactWriteCommand({TransactItems:ops.map(op=>{
        const conditional=op.expected===undefined?{}:op.expected===0?{ConditionExpression:"attribute_not_exists(pk)"}:{ConditionExpression:"revision = :expected",ExpressionAttributeValues:{":expected":op.expected}};
        return op.remove?{Delete:{TableName:this.table,Key:{pk:op.pk,sk:op.sk},...conditional}}:{Put:{TableName:this.table,Item:{pk:op.pk,sk:op.sk,payload:JSON.stringify(op.value),revision:op.value.version||1,...(op.value.expiresAt?{ttl:op.value.expiresAt}:{})},...conditional}};
      })}));
    }catch(e){
      if(e.name==="TransactionCanceledException"&&e.CancellationReasons?.some(r=>r.Code==="ConditionalCheckFailed")){const err=new Error("This writing changed in another window. Reload it before saving.");err.status=409;throw err;}
      throw e;
    }
  }
}
const service = new Writes(new DynamoStore(process.env.WRITES_TABLE));
const READS_AUTH_BASE = (process.env.READS_AUTH_BASE || "https://i0u0tcrbfb.execute-api.us-west-2.amazonaws.com").replace(/\/$/, "");

async function authenticate(headers){
  // API Gateway HTTP APIs lowercase header names; still accept either form.
  const raw=headers.authorization||headers.Authorization||"";
  const bearer=Array.isArray(raw)?raw[0]:raw;
  if(typeof bearer!=="string"||!bearer.startsWith("Bearer "))return null;
  const token=bearer.slice(7).trim();
  // Reads issues opaque session tokens stored as session#<token> in reads-users.
  // Allow base64url-length tokens; reject obvious garbage without logging the value.
  if(!/^[a-zA-Z0-9_-]{16,256}$/.test(token))return null;
  const {Item:session}=await ddb.send(new GetCommand({TableName:process.env.USERS_TABLE,Key:{username:"session#"+token},ConsistentRead:true}));
  if(!session||session.itemType!=="session"||!Number.isFinite(session.expiresAt)||session.expiresAt<=Math.floor(Date.now()/1000)||typeof session.userUsername!=="string")return null;
  const {Item:user}=await ddb.send(new GetCommand({TableName:process.env.USERS_TABLE,Key:{username:session.userUsername},ConsistentRead:true}));
  if(!user||user.itemType!=="user")return null;
  return {owner:"member#"+user.username,user:{username:user.username,display_name:user.displayName}};
}

/** Browser calls Writes (CORS already configured). Lambda talks to Reads server-side — avoids Reads CORS / Failed to fetch. */
async function proxyReadsLogin(data){
  const username=typeof data?.username==="string"?data.username.trim():"";
  const password=typeof data?.password==="string"?data.password:"";
  if(!username||!password){
    const err=new Error("Username and password required");err.status=400;throw err;
  }
  let response;
  try{
    response=await fetch(READS_AUTH_BASE+"/api/auth/login",{
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({username,password})
    });
  }catch{
    const err=new Error("Could not reach the Reads sign-in service. Try again in a moment.");err.status=502;throw err;
  }
  const out=await response.json().catch(()=>({}));
  if(!response.ok){
    const err=new Error(out.detail||out.error||"Sign-in failed. Check your Reads username and password.");
    err.status=response.status===401||response.status===403?401:400;
    throw err;
  }
  const token=out.token||out.access_token||out.accessToken;
  if(!token||typeof token!=="string"){
    const err=new Error("Reads signed you in but did not return a session token Writes can use.");err.status=502;throw err;
  }
  const u=out.user||{};
  return {
    token,
    user:{
      username:u.username||username,
      display_name:u.display_name||u.displayName||u.username||username
    }
  };
}

export async function handler(event){
  const method=event.requestContext?.http?.method||event.httpMethod,path=event.rawPath||event.path||"",headers={"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"};
  try{
    if(method==="GET"&&path==="/api/health")return {statusCode:200,headers,body:JSON.stringify({ok:true,mode:"production"})};
    let data={};
    if(event.body){
      const raw=event.isBase64Encoded?Buffer.from(event.body,"base64").toString("utf8"):event.body;
      if(Buffer.byteLength(raw)>5_000_000)return {statusCode:413,headers,body:JSON.stringify({error:"The request is larger than 5 MB."})};
      try{data=JSON.parse(raw);}catch{return {statusCode:400,headers,body:JSON.stringify({error:"Invalid JSON request."})};}
    }
    // Unauthenticated login proxy — must run before session auth / private routes.
    if(method==="POST"&&path==="/api/auth/login"){
      const result=await proxyReadsLogin(data);
      return {statusCode:200,headers,body:JSON.stringify(result)};
    }
    const publicRead=path.startsWith("/api/public/")&&method==="GET";
    const auth=publicRead?null:await authenticate(event.headers||{});
    if(path==="/api/bootstrap"){
      if(!auth)return {statusCode:401,headers,body:JSON.stringify({error:"Sign in with your Reads member account."})};
      return {statusCode:200,headers,body:JSON.stringify({user:auth.user,preview:false})};
    }
    const result=await service.route(auth?.owner,method,path,data);
    return {statusCode:200,headers,body:JSON.stringify(result)};
  }catch(e){
    const status=e.name==="ZodError"?400:e.status||500;
    if(status>=500)console.error("Writes request failed",e.name); // Never log manuscripts, passwords, or session tokens.
    return {statusCode:status,headers,body:JSON.stringify({error:e.name==="ZodError"?e.issues.map(i=>i.message).join(" "):status===500?"The request could not be completed. Your saved writing is unchanged.":e.message})};
  }
}
