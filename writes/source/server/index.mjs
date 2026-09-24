import express from "express";
import crypto from "node:crypto";
import { SQLiteStore } from "./storage.mjs";
import { Writes } from "./core.mjs";

const app = express(), store = new SQLiteStore(process.env.WRITES_DB || "./data/writes.sqlite"), service = new Writes(store);
const sessions = new Map(), rate = new Map();
app.disable("x-powered-by");
app.use((req,res,next)=>{
  res.set({"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({limit:"5mb"}));
app.get("/api/health",(_req,res)=>res.json({ok:true,mode:"preview"}));
app.get("/api/bootstrap",async(req,res,next)=>{
  try {
    // The private preview proxy sets X-Visitor-Id. Never fall back to a shared remote identity.
    const visitor = req.get("x-visitor-id") || ((req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1") ? "local-preview" : "");
    if(!visitor) return res.status(401).json({error:"Open this app through its private Computer preview to start your own workspace."});
    const owner="preview#"+crypto.createHash("sha256").update(visitor).digest("hex");
    await service.seed(owner);
    const token=crypto.randomBytes(32).toString("base64url");
    sessions.set(token,{owner,expiresAt:Date.now()+86400000});
    for(const [t,s] of sessions) if(s.expiresAt<Date.now()) sessions.delete(t);
    res.json({token,user:{display_name:"Your preview desk"},preview:true});
  } catch(e){ next(e); }
});
app.use("/api",async(req,res,next)=>{
  try {
    const token=req.get("authorization")?.replace(/^Bearer /,""), session=sessions.get(token);
    const owner=session?.expiresAt>Date.now()?session.owner:null;
    if(req.method==="POST" && req.path==="/import/preview") {
      const r=rate.get(owner)||{at:Date.now(),n:0};
      if(Date.now()-r.at>60000){r.at=Date.now();r.n=0;}
      if(++r.n>10) return res.status(429).json({error:"Please wait a minute before another import."});
      rate.set(owner,r);
    }
    res.json(await service.route(owner,req.method,"/api"+req.path,req.body,{display_name:"Your preview desk"}));
  } catch(e){next(e);}
});
app.use(express.static("dist/public"));
app.use((err,req,res,_next)=>{
  if(err.name==="ZodError") return res.status(400).json({error:err.issues.map(i=>i.message).join(" ")});
  const status=err.status||500;
  if(status>=500) console.error(err.message);
  res.status(status).json({error:status===500?"The request could not be completed. Your saved writing is unchanged. Try again.":err.message});
});
app.listen(Number(process.env.PORT||8110),"0.0.0.0",()=>console.log("Writes preview listening on",process.env.PORT||8110));
