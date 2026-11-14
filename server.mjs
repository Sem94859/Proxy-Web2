import express from "express";
import { load } from "cheerio";
import { CookieJar } from "tough-cookie";
import { lookup } from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
const MAX_BODY = 8 * 1024 * 1024;
const SESSION_TTL = 60 * 60 * 1000;

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
  return true;
}
async function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Invalid address"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS websites are supported");
  if (u.username || u.password) throw new Error("Addresses containing credentials are not supported");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("Local network addresses are not available");
  if (net.isIP(host)) {
    if (privateIP(host)) throw new Error("Private network addresses are not available");
  } else {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some(r => privateIP(r.address))) throw new Error("This destination is not available");
  }
  return u;
}
function getSession(req,res) {
  let id = req.cookies?.pw_session;
  let s = id && sessions.get(id);
  if (!s || Date.now() - s.last > SESSION_TTL) {
    id = crypto.randomBytes(24).toString("base64url");
    s = { jar: new CookieJar(), last: Date.now(), count: 0, window: Date.now() };
    sessions.set(id,s);
    res.cookie("pw_session", id, { httpOnly:true, sameSite:"lax", secure:process.env.NODE_ENV==="production", maxAge:SESSION_TTL });
  }
  if (Date.now()-s.window > 60_000) { s.window=Date.now(); s.count=0; }
  s.count++; s.last=Date.now();
  if (s.count > 180) throw new Error("Too many requests in a short time. Please wait a moment.");
  return s;
}
app.use((req,res,next)=>{
  const raw=req.headers.cookie||"";
  const match=raw.match(/(?:^|;\s*)pw_session=([^;]+)/);
  req.cookies = match ? {pw_session:decodeURIComponent(match[1])} : {};
  next();
});
app.use(express.static(path.join(__dirname,"public"),{index:"index.html"}));
app.get("/health",(req,res)=>res.json({ok:true,service:"ProxyWeb",version:"6.0"}));
app.get("/app",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

function encodeProxy(url) { return Buffer.from(url).toString("base64url"); }
function proxyUrl(url) { return "/p/" + encodeProxy(url); }
function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)(?!data:|blob:|#)([^)'"]+)\1\s*\)/gi, (all,q,u) => {
    try { return `url("${proxyUrl(new URL(u.trim(),base).href)}")`; } catch { return all; }
  }).replace(/@import\s+(?:url\()?['"]?([^'")\s;]+)['"]?\)?/gi,(all,u)=>{
    try{return `@import url("${proxyUrl(new URL(u,base).href)}")`;}catch{return all;}
  });
}
function rewriteSrcset(value, base) {
  return value.split(",").map(part=>{
    const bits=part.trim().split(/\s+/); try{bits[0]=proxyUrl(new URL(bits[0],base).href);}catch{} return bits.join(" ");
  }).join(", ");
}
function rewriteHtml(html, base, responseUrl) {
  const $ = load(html, { decodeEntities:false });
  $("base").remove();
  const attrs=["href","src","action","poster","data","xlink:href","formaction"];
  $("*").each((_,el)=>{
    for(const attr of attrs){
      const v=$(el).attr(attr);
      if(!v || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(v)) continue;
      try { $(el).attr(attr,proxyUrl(new URL(v,responseUrl||base).href)); } catch {}
    }
    const srcset=$(el).attr("srcset"); if(srcset) $(el).attr("srcset",rewriteSrcset(srcset,responseUrl||base));
    const style=$(el).attr("style"); if(style) $(el).attr("style",rewriteCss(style,responseUrl||base));
  });
  $("style").each((_,el)=>$(el).text(rewriteCss($(el).text(),responseUrl||base)));
  $("form").attr("target","_self");

  $("head").append(`<script>
  (() => {
    const proxyPrefix = "/p/";
    const original = ${JSON.stringify(responseUrl||base)};
    function encode(u){try{const parsed=new URL(u,original);if(parsed.origin===location.origin&&parsed.pathname.startsWith(proxyPrefix))return parsed.pathname+parsed.search+parsed.hash;return proxyPrefix+btoa(unescape(encodeURIComponent(parsed.href))).split("+").join("-").split("/").join("_").replace(/=+$/,"")}catch{return u}}
    const nativeFetch=window.fetch;
    window.fetch=function(input,init){try{if(typeof input==="string")input=encode(input);else if(input&&input.url)input=new Request(encode(input.url),input)}catch{}return nativeFetch.call(this,input,init)};
    const nativeOpen=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...rest){try{url=encode(url)}catch{}return nativeOpen.call(this,method,url,...rest)};
    const nativeSet=history.pushState;
    history.pushState=function(state,title,url){if(url){try{url=encode(url)}catch{}}return nativeSet.call(this,state,title,url)};
    const nativeReplace=history.replaceState;
    history.replaceState=function(state,title,url){if(url){try{url=encode(url)}catch{}}return nativeReplace.call(this,state,title,url)};
    document.addEventListener("click",e=>{const a=e.target.closest&&e.target.closest("a");if(a&&a.href&&!a.target){e.preventDefault();location.href=encode(a.href)}},true);
    document.addEventListener("submit",e=>{const f=e.target;if(f&&f.action){f.action=encode(f.action)}},true);
    try{parent.postMessage({type:"proxyweb:title",title:document.title},"*")}catch{}
  })();
  <\/script>`);
  return $.html();
}
app.all("/p/:encoded", async (req,res)=>{
  let target;
  try { target=Buffer.from(req.params.encoded,"base64url").toString("utf8"); }
  catch { return res.status(400).send("Invalid ProxyWeb address"); }
  try {
    const url=await validateTarget(target);
    const session=getSession(req,res);
    const cookie=await session.jar.getCookieString(url.href);
    const headers={
      "user-agent":req.headers["user-agent"]||"Mozilla/5.0 ProxyWeb",
      "accept":req.headers.accept||"*/*",
      "accept-language":req.headers["accept-language"]||"en-US,en;q=0.9",
      "accept-encoding":"identity"
    };
    if(cookie) headers.cookie=cookie;
    if(req.headers.range) headers.range=req.headers.range;
    if(req.headers["content-type"]) headers["content-type"]=req.headers["content-type"];
    const method=["GET","HEAD","POST"].includes(req.method)?req.method:"GET";
    const body=method==="POST"?req:undefined;
    const upstream=await fetch(url.href,{method,headers,body,redirect:"manual",signal:AbortSignal.timeout(30000),duplex:body?"half":undefined});
    const setCookie=upstream.headers.getSetCookie?.()||[];
    for(const c of setCookie) await session.jar.setCookie(c,url.href,{ignoreError:true});
    if([301,302,303,307,308].includes(upstream.status) && upstream.headers.get("location")){
      const dest=new URL(upstream.headers.get("location"),url).href;
      return res.redirect(upstream.status,proxyUrl(dest));
    }
    const type=upstream.headers.get("content-type")||"application/octet-stream";
    res.status(upstream.status);
    res.set("Content-Type",type);
    for(const h of ["content-length","content-range","accept-ranges","cache-control","last-modified","etag"]) {
      const v=upstream.headers.get(h); if(v) res.set(h,v);
    }
    res.set("X-Content-Type-Options","nosniff");
    if(type.includes("text/html")){
      const text=await upstream.text();
      if(text.length>MAX_BODY) return res.status(413).send("Page is too large for this demo proxy.");
      return res.send(rewriteHtml(text,url.href,upstream.url||url.href));
    }
    if(type.includes("text/css")){
      const text=await upstream.text();
      return res.send(rewriteCss(text,url.href));
    }
    if(!upstream.body) return res.end();
    const reader=upstream.body.getReader();
    while(true){const {done,value}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await new Promise(r=>res.once("drain",r));}
    res.end();
  } catch(err) {
    const status=err.name==="TimeoutError"?504:400;
    res.status(status).send(`<main style="font:16px system-ui;max-width:650px;margin:12vh auto;padding:24px;color:#24445f"><h2>ProxyWeb couldn't load this page</h2><p>${String(err.message).replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]))}</p><p>Some websites restrict proxies or require browser features that cannot be relayed.</p><a href="/app">Back to ProxyWeb</a></main>`);
  }
});
app.use((err,req,res,next)=>{res.status(500).send("ProxyWeb server error");});
app.listen(PORT,"0.0.0.0",()=>console.log(`ProxyWeb listening on ${PORT}`));
