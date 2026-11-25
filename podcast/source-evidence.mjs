import https from 'node:https';
import dns from 'node:dns';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
export function publicIPv4(ip) {
  if (isIP(ip)!==4) return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !([0,10,127].includes(a) || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===198&&[18,19].includes(b)) || (a===192&&b===0) || (a===198&&b===51&&c===100) || (a===203&&b===0&&c===113));
}
/** Resolve and pin a public address on each hop; no cookies or credentials. */
export function readPublicPage(raw, hops=0) {
  const url=new URL(raw);
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || hops>3) return Promise.reject(new Error('Unsafe source URL'));
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{timeout:10000,autoSelectFamily:false,lookup:(host,options,done)=>dns.lookup(host,{family:4},(err,address,family)=>{
      if(err || !publicIPv4(address)) return done(new Error('Private source address blocked'));
      done(null,address,family);
    }),headers:{'user-agent':'TechWhoKnows-Podcast/1.0','accept':'text/html,text/plain'}},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();if(!res.headers.location)return reject(new Error('Redirect missing'));return resolve(readPublicPage(new URL(res.headers.location,url).href,hops+1));}
      if(res.statusCode!==200 || !/text\/(html|plain)/.test(res.headers['content-type']||'')){res.resume();return reject(new Error('Source unavailable'));}
      let bytes=0;const chunks=[];
      res.on('data',c=>{bytes+=c.length;if(bytes>600000){request.destroy(new Error('Source too large'));return;}chunks.push(c);});
      res.on('error',reject);res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
    });request.on('timeout',()=>request.destroy(new Error('Source timeout')));request.on('error',reject);
  });
}
export async function collectEvidence(sources, read = readPublicPage) {
  return Promise.all(sources.map(async source=>{
    const upstream=[];
    for(const url of [...new Set(source.originalUrls||[])].slice(0,3)){
      try {
        const host=new URL(url).hostname;if(host==='techwhoknows.com'||host.endsWith('.techwhoknows.com'))continue;
        const html=await read(url);
        const text=html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().slice(0,16000);
        if(text.length<300 || /just a moment|verify you are human|access denied/i.test(text.slice(0,600)))continue;
        upstream.push({url,text,sha256:createHash('sha256').update(text).digest('hex'),retrievedAt:new Date().toISOString()});
      }catch{}
    }
    if(!upstream.length)throw new Error(`Original source verification blocked for ${source.id}`);
    return {...source,upstream};
  }));
}
