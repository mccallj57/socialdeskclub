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
async function authenticate(headers){
  const bearer=headers.authorization||headers.Authorization||"";
  if(!bearer.startsWith("Bearer "))return null;
  const token=bearer.slice(7);
  if(!/^[a-zA-Z0-9_-]{20,100}$/.test(token))return null;
  const {Item:session}=await ddb.send(new GetCommand({TableName:process.env.USERS_TABLE,Key:{username:"session#"+token},ConsistentRead:true}));
  if(!session||session.itemType!=="session"||!Number.isFinite(session.expiresAt)||session.expiresAt<=Math.floor(Date.now()/1000)||typeof session.userUsername!=="string")return null;
  const {Item:user}=await ddb.send(new GetCommand({TableName:process.env.USERS_TABLE,Key:{username:session.userUsername},ConsistentRead:true}));
  if(!user||user.itemType!=="user")return null;
  return {owner:"member#"+user.username,user:{username:user.username,display_name:user.displayName}};
}
export async function handler(event){
  const method=event.requestContext?.http?.method||event.httpMethod,path=event.rawPath||event.path||"",headers={"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"};
  try{
    if(method==="GET"&&path==="/api/health")return {statusCode:200,headers,body:JSON.stringify({ok:true,mode:"production"})};
    const publicRead=path.startsWith("/api/public/")&&method==="GET";
    const auth=publicRead?null:await authenticate(event.headers||{});
    if(path==="/api/bootstrap"){
      if(!auth)return {statusCode:401,headers,body:JSON.stringify({error:"Sign in with your Reads member account."})};
      return {statusCode:200,headers,body:JSON.stringify({user:auth.user,preview:false})};
    }
    let data={};
    if(event.body){
      const raw=event.isBase64Encoded?Buffer.from(event.body,"base64").toString("utf8"):event.body;
      if(Buffer.byteLength(raw)>5_000_000)return {statusCode:413,headers,body:JSON.stringify({error:"The request is larger than 5 MB."})};
      try{data=JSON.parse(raw);}catch{return {statusCode:400,headers,body:JSON.stringify({error:"Invalid JSON request."})};}
    }
    const result=await service.route(auth?.owner,method,path,data);
    return {statusCode:200,headers,body:JSON.stringify(result)};
  }catch(e){
    const status=e.name==="ZodError"?400:e.status||500;
    if(status>=500)console.error("Writes request failed",e.name); // Never log manuscripts, passwords, or session tokens.
    return {statusCode:status,headers,body:JSON.stringify({error:e.name==="ZodError"?e.issues.map(i=>i.message).join(" "):status===500?"The request could not be completed. Your saved writing is unchanged.":e.message})};
  }
}
