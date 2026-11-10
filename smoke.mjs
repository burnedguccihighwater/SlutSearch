import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token='test-bot-token-for-local-validation';
const port=35511;
const base=`http://127.0.0.1:${port}`;
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1NwAAAABJRU5ErkJggg==','base64');
function signed(user={id:111222333,first_name:'Test',username:'testcreator'},date=Math.floor(Date.now()/1000)) {
 const params=new URLSearchParams({user:JSON.stringify(user),auth_date:String(date),query_id:'AAE'});
 const check=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const key=createHmac('sha256','WebAppData').update(token).digest();
 const hash=createHmac('sha256',key).update(check).digest('hex');
 params.append('hash',hash);return 'tma '+params.toString();
}
let proc,tmp;
async function call(endpoint,{method='GET',data,form,auth=signed()}={}) {
 const headers={Authorization:auth};if(data)headers['content-type']='application/json';
 const res=await fetch(base+endpoint,{method,headers,body:form||(data?JSON.stringify(data):undefined)});
 const json=await res.json();return {status:res.status,...json};
}
async function ready(){for(let i=0;i<100;i++){try{const r=await fetch(base+'/health');if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,50))}throw new Error('Server did not start')}
test('API: Telegram verification, tagged upload, moderation, search, likes, bookmarks, playlists',async(t)=>{
 tmp=await mkdtemp(path.join(tmpdir(),'slutsearch-smoke-'));
 proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),BOT_TOKEN:token,ADMIN_TG_IDS:'111222333',DATA_DIR:tmp,UPLOAD_DIR:path.join(tmp,'uploads'),DEV_AUTH:'0',AUTO_APPROVE_UPLOADS:'0'},stdio:'pipe'});
 t.after(async()=>{proc.kill('SIGTERM');await rm(tmp,{recursive:true,force:true})});
 await ready();
 const unauthed=await fetch(base+'/api/me');assert.equal(unauthed.status,401);
 let result=await call('/api/me');assert.equal(result.status,200);assert.equal(result.id,'111222333');
 result=await call('/api/me',{auth:signed(undefined,Math.floor(Date.now()/1000)-86401)});assert.equal(result.status,401);
 const form=new FormData();form.set('title','Test illustration');form.set('tags','blue, abstract, drawing');form.set('file',new Blob([image],{type:'image/png'}),'art.png');
 result=await call('/api/posts',{method:'POST',form});assert.equal(result.status,201);assert.equal(result.post.status,'pending');
 const id=result.post.id;
 result=await call('/api/posts?tag=blue');assert.equal(result.total,0);
 result=await call('/api/admin/posts');assert.equal(result.posts.length,1);
 result=await call(`/api/admin/posts/${id}/moderate`,{method:'POST',data:{status:'approved'}});assert.equal(result.post.status,'approved');
 result=await call('/api/posts?tag=blue&tag=drawing');assert.equal(result.total,1);
 result=await call('/api/posts?tag=blue&tag=missing');assert.equal(result.total,0);
 result=await call('/api/posts?tag=a&tag=b&tag=c&tag=d&tag=e&tag=f');assert.equal(result.status,400);
 result=await call('/api/tags');assert.ok(result.tags.some(t=>t.name==='blue'));
 result=await call(`/api/posts/${id}/like`,{method:'POST'});assert.equal(result.likes,1);
 result=await call('/api/posts?sort=top');assert.equal(result.posts[0].likes,1);
 result=await call(`/api/posts/${id}/bookmark`,{method:'POST'});assert.equal(result.bookmarked,true);
 result=await call('/api/posts?source=bookmarks');assert.equal(result.total,1);
 result=await call('/api/playlists',{method:'POST',data:{name:'Favorites'}});assert.equal(result.status,201);const listId=result.playlist.id;
 result=await call(`/api/playlists/${listId}/posts`,{method:'POST',data:{postId:id}});assert.equal(result.ok,true);
 result=await call(`/api/playlists/${listId}/posts`);assert.equal(result.posts.length,1);
 result=await call(`/api/posts/${id}/report`,{method:'POST',data:{reason:'copyright'}});assert.equal(result.ok,true);
 result=await call('/api/admin/posts');assert.equal(result.reports.length,1);
 result=await call(`/api/playlists/${listId}/posts/${id}`,{method:'DELETE'});assert.equal(result.ok,true);
 result=await call(`/api/playlists/${listId}`,{method:'DELETE'});assert.equal(result.ok,true);
});
