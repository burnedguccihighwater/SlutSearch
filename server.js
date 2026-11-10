import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA, 'database.json');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const db = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { users: [], posts: [], bookmarks: [], likes: [], playlists: [], playlistPosts: [], reports: [], botOffset: 0 };
for (const key of ['users','posts','bookmarks','likes','playlists','playlistPosts','reports']) db[key] ??= [];
db.botOffset ??= 0;
const TOKEN = process.env.BOT_TOKEN || '';
const DEV_AUTH = process.env.DEV_AUTH === '1';
const AUTO_APPROVE = DEV_AUTH && process.env.AUTO_APPROVE_UPLOADS === '1';
const PORT = Number(process.env.PORT || 3000);
const LIMIT = Math.min(Math.max(Number(process.env.MAX_UPLOAD_MB || 50), 1), 200) * 1024 * 1024;
const ADMIN_IDS = new Set((process.env.ADMIN_TG_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon' };
const UPLOAD_MIMES = { 'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov' };
const bursts = new Map();

function save() {
  const p = DATA_FILE + '.tmp';
  fs.writeFileSync(p, JSON.stringify(db, null, 2));
  fs.renameSync(p, DATA_FILE);
}
function reply(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(body);
}
function fail(code, message) { const error = new Error(message); error.status = code; throw error; }
function tagsFrom(value, min=0, max=5) {
  let tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  tags = tags.map(t => String(t).trim().replace(/^#+/, '').replace(/\s+/g,' ').toLowerCase()).filter(Boolean);
  if (tags.some(t => t.length > 40 || /[<>\x00-\x1f]/.test(t))) fail(400,'Некорректный тег (до 40 символов).');
  tags = [...new Set(tags)];
  if (tags.length < min || tags.length > max) fail(400,`Нужно от ${min} до ${max} тегов.`);
  return tags;
}
function validateTelegram(initData) {
  if (!TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !authDate) return null;
  if (Math.abs(Date.now()/1000 - authDate) > 86400) return null;
  const check = [...params.entries()].filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const calc = createHmac('sha256', key).update(check).digest('hex');
  if (!timingSafeEqual(Buffer.from(calc,'hex'), Buffer.from(hash,'hex'))) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch { return null; }
}
function identify(req) {
  const value = req.headers.authorization || '';
  const init = value.startsWith('tma ') ? value.slice(4) : '';
  const telegram = validateTelegram(init);
  const user = telegram || (DEV_AUTH ? { id:987654321, first_name:'Demo', username:'demo_user', photo_url:'' } : null);
  if (!user) fail(401,'Открой SlutSearch через Telegram, чтобы войти.');
  const id = String(user.id);
  let dbUser = db.users.find(u => u.id === id);
  const fields = { id, displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'User', username:user.username || '', avatar:user.photo_url || '' };
  if (!dbUser) { dbUser = { ...fields, joinedAt:Date.now() }; db.users.push(dbUser); save(); }
  else if (dbUser.displayName !== fields.displayName || dbUser.username !== fields.username || dbUser.avatar !== fields.avatar) { Object.assign(dbUser,fields); save(); }
  return dbUser;
}
function getJson(req, max=25000) {
  return new Promise((resolve,reject) => {
    let content = '', size=0;
    req.on('data', chunk => { size += chunk.length; if(size>max){reject(Object.assign(new Error('Слишком большой запрос.'),{status:413}));req.destroy();} else content += chunk; });
    req.on('end', () => { try{resolve(content ? JSON.parse(content) : {})}catch{reject(Object.assign(new Error('Неверный JSON.'),{status:400}))} });
    req.on('error',reject);
  });
}
async function multipart(req) {
  const clen = Number(req.headers['content-length'] || 0);
  if (clen > LIMIT + 100000) fail(413,'Файл слишком большой.');
  // Request.formData is available natively in Node 22. Enforce a hard stream limit
  // even if a client omits or spoofs Content-Length. MVP still buffers the file in memory.
  let bytes=0;
  const limiter=new Transform({transform(chunk,encoding,callback) {
    bytes+=chunk.length;
    if(bytes>LIMIT+100000)callback(new Error('Upload exceeds size limit.'));
    else callback(null,chunk);
  }});
  req.pipe(limiter);
  const request = new Request('http://localhost/upload',{ method:'POST',headers:req.headers,body:Readable.toWeb(limiter),duplex:'half' });
  let form;
  try { form = await request.formData(); }
  catch(e){ if(bytes>LIMIT+100000)fail(413,'Файл слишком большой.'); throw e; }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !('arrayBuffer' in file)) fail(400,'Выбери изображение или видео.');
  if (file.size < 1 || file.size > LIMIT) fail(413,'Недопустимый размер файла.');
  if (!UPLOAD_MIMES[file.type]) fail(415,'Допустимые форматы: JPG, PNG, WEBP, GIF, MP4, WEBM, MOV.');
  const buf = Buffer.from(await file.arrayBuffer());
  const isJpg=buf.length>3 && buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF;
  const isPng=buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  const isGif=buf.subarray(0,3).toString()==='GIF';
  const isWebp=buf.subarray(0,4).toString()==='RIFF' && buf.subarray(8,12).toString()==='WEBP';
  const isMp4=buf.length>12 && buf.subarray(4,8).toString()==='ftyp';
  const isWebm=buf.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'));
  const signatureOk = file.type==='image/jpeg' ? isJpg : file.type==='image/png' ? isPng : file.type==='image/gif' ? isGif : file.type==='image/webp' ? isWebp : file.type==='video/webm' ? isWebm : isMp4;
  if (!signatureOk) fail(415,'Содержимое файла не соответствует его формату.');
  return { form, buffer:buf, extension:UPLOAD_MIMES[file.type], type:file.type };
}
function publicPost(p, me) {
  const author = db.users.find(u=>u.id===p.ownerId);
  return { id:p.id, title:p.title, tags:p.tags, kind:p.kind, mediaUrl:`/media/${p.file}`, ai:p.ai, createdAt:p.createdAt, views:p.views||0, likes:p.likes||0, liked:!!db.likes.find(x=>x.postId===p.id && x.userId===me.id), status:p.status,
    author:{id:p.ownerId, name:author?.displayName||'User', username:author?.username||''}, bookmarked:!!db.bookmarks.find(x=>x.postId===p.id && x.userId===me.id), owned:p.ownerId===me.id };
}
function rate(id, action, max, windowMs) {
  const key = id+':'+action, now = Date.now();
  const items=(bursts.get(key)||[]).filter(t=>now-t<windowMs);
  if(items.length>=max) fail(429,'Слишком много запросов. Попробуй позднее.');
  items.push(now);bursts.set(key,items);
}
function assertPost(id, me) {
  const post=db.posts.find(p=>p.id===id && (p.status==='approved' || p.ownerId===me.id || ADMIN_IDS.has(me.id)));
  if(!post) fail(404,'Публикация не найдена.');
  return post;
}
const PAGE_SIZE=18;
async function api(req,res,url) {
  const me=identify(req), route=url.pathname.replace(/^\/api/,''), method=req.method;
  if(method==='GET' && route==='/config') return reply(res,200,{ botUsername:process.env.BOT_USERNAME||'', dev:DEV_AUTH, isAdmin:ADMIN_IDS.has(me.id) });
  if(method==='GET' && route==='/me') return reply(res,200,{ ...me, posts:db.posts.filter(p=>p.ownerId===me.id).length, bookmarks:db.bookmarks.filter(b=>b.userId===me.id).length, playlists:db.playlists.filter(p=>p.ownerId===me.id).length });
  if(method==='GET' && route==='/tags') {
    const counts=new Map(); for(const p of db.posts.filter(p=>p.status==='approved')) for(const t of p.tags) counts.set(t,(counts.get(t)||0)+1);
    return reply(res,200,{ tags:[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([name,count])=>({name,count})) });
  }
  if(method==='GET' && route==='/posts') {
    const tags=tagsFrom(url.searchParams.getAll('tag'),0,5);
    const media=url.searchParams.get('media')||'all', sort=url.searchParams.get('sort')||'latest';
    const source=url.searchParams.get('source')||'all', ai=url.searchParams.get('ai')==='exclude';
    const owner=url.searchParams.get('owner')||'';
    const offset=Math.max(0,Math.min(Number(url.searchParams.get('offset')||0)||0,100000));
    let posts=db.posts.filter(p=>p.status==='approved' || (owner===me.id && p.ownerId===me.id));
    if(owner) posts=posts.filter(p=>p.ownerId===owner);
    if(source==='bookmarks') { const saved=new Set(db.bookmarks.filter(b=>b.userId===me.id).map(b=>b.postId));posts=posts.filter(p=>saved.has(p.id)); }
    if(tags.length) posts=posts.filter(p=>tags.every(t=>p.tags.includes(t)));
    if(media==='images') posts=posts.filter(p=>p.kind==='image');
    if(media==='videos') posts=posts.filter(p=>p.kind==='video');
    if(ai) posts=posts.filter(p=>!p.ai);
    posts.sort((a,b)=>sort==='oldest'?a.createdAt-b.createdAt:sort==='views'?b.views-a.views:sort==='top'?b.likes-a.likes:sort==='shuffle'?pseudo(b.id)-pseudo(a.id):b.createdAt-a.createdAt);
    return reply(res,200,{ posts:posts.slice(offset,offset+PAGE_SIZE).map(p=>publicPost(p,me)), nextOffset:offset+PAGE_SIZE<posts.length?offset+PAGE_SIZE:null, total:posts.length });
  }
  if(method==='POST' && route==='/posts') {
    rate(me.id,'upload',8,60*60*1000);
    const {form,buffer,extension,type}=await multipart(req);
    const title=String(form.get('title')||'Untitled').trim().slice(0,100);
    const tags=tagsFrom(String(form.get('tags')||''),1,12);
    const filename=randomUUID()+extension;
    fs.writeFileSync(path.join(UPLOADS,filename),buffer,{flag:'wx'});
    const post={id:randomUUID(),ownerId:me.id,title,titleSearch:title.toLowerCase(),tags,kind:type.startsWith('video/')?'video':'image',file:filename,ai:String(form.get('ai'))==='true',createdAt:Date.now(),views:0,likes:0,status:AUTO_APPROVE?'approved':'pending'};
    db.posts.push(post);save();
    return reply(res,201,{post:publicPost(post,me),message:post.status==='pending'?'Загружено и отправлено на модерацию.':'Опубликовано.'});
  }
  const bookmark=route.match(/^\/posts\/([\w-]+)\/bookmark$/);
  if(bookmark && (method==='POST'||method==='DELETE')) {
    assertPost(bookmark[1],me);
    db.bookmarks=db.bookmarks.filter(x=>!(x.postId===bookmark[1]&&x.userId===me.id));
    if(method==='POST') db.bookmarks.push({userId:me.id,postId:bookmark[1],createdAt:Date.now()});
    save();return reply(res,200,{bookmarked:method==='POST'});
  }
  const like=route.match(/^\/posts\/([\w-]+)\/like$/);
  if(like && (method==='POST'||method==='DELETE')) {
    const post=assertPost(like[1],me);db.likes=db.likes.filter(x=>!(x.postId===post.id && x.userId===me.id));
    if(method==='POST')db.likes.push({userId:me.id,postId:post.id,createdAt:Date.now()});
    post.likes=db.likes.filter(x=>x.postId===post.id).length;save();return reply(res,200,{liked:method==='POST',likes:post.likes});
  }
  const view=route.match(/^\/posts\/([\w-]+)\/view$/);
  if(view && method==='POST') { const p=assertPost(view[1],me);p.views++;save();return reply(res,200,{views:p.views}); }
  if(method==='GET' && route==='/playlists') {
    const mine=db.playlists.filter(p=>p.ownerId===me.id).map(p=>({...p,count:db.playlistPosts.filter(x=>x.playlistId===p.id).length}));
    return reply(res,200,{playlists:mine});
  }
  if(method==='POST' && route==='/playlists') {
    const body=await getJson(req),name=String(body.name||'').trim().slice(0,70);
    if(!name) fail(400,'Укажи название плейлиста.');
    rate(me.id,'playlist',30,3600000);
    const playlist={id:randomUUID(),ownerId:me.id,name,createdAt:Date.now()}; db.playlists.push(playlist);save();
    return reply(res,201,{playlist:{...playlist,count:0}});
  }
  const playlistPosts=route.match(/^\/playlists\/([\w-]+)\/posts$/);
  if(playlistPosts && method==='GET') {
    const list=db.playlists.find(p=>p.id===playlistPosts[1]&&p.ownerId===me.id); if(!list) fail(404,'Плейлист не найден.');
    const posts=db.playlistPosts.filter(p=>p.playlistId===list.id).map(x=>db.posts.find(p=>p.id===x.postId)).filter(p=>p && (p.status==='approved'||p.ownerId===me.id));
    return reply(res,200,{playlist:list,posts:posts.map(p=>publicPost(p,me))});
  }
  if(playlistPosts && method==='POST') {
    const list=db.playlists.find(p=>p.id===playlistPosts[1]&&p.ownerId===me.id);if(!list) fail(404,'Плейлист не найден.');
    const body=await getJson(req),post=assertPost(String(body.postId||''),me);
    if(!db.playlistPosts.some(p=>p.playlistId===list.id&&p.postId===post.id))db.playlistPosts.push({playlistId:list.id,postId:post.id,createdAt:Date.now()});
    save();return reply(res,200,{ok:true});
  }
  const onePlaylist=route.match(/^\/playlists\/([\w-]+)$/);
  if(onePlaylist && method==='DELETE') {
    const index=db.playlists.findIndex(p=>p.id===onePlaylist[1]&&p.ownerId===me.id);if(index<0) fail(404,'Плейлист не найден.');
    db.playlists.splice(index,1);db.playlistPosts=db.playlistPosts.filter(p=>p.playlistId!==onePlaylist[1]);save();return reply(res,200,{ok:true});
  }
  const removeFromPlaylist=route.match(/^\/playlists\/([\w-]+)\/posts\/([\w-]+)$/);
  if(removeFromPlaylist && method==='DELETE') {
    if(!db.playlists.some(p=>p.id===removeFromPlaylist[1]&&p.ownerId===me.id)) fail(404,'Плейлист не найден.');
    db.playlistPosts=db.playlistPosts.filter(p=>!(p.playlistId===removeFromPlaylist[1]&&p.postId===removeFromPlaylist[2]));save();return reply(res,200,{ok:true});
  }
  const report=route.match(/^\/posts\/([\w-]+)\/report$/);
  if(report && method==='POST') {
    assertPost(report[1],me);rate(me.id,'reports',10,3600000);
    const body=await getJson(req),reason=String(body.reason||'other');
    if(!['underage','nonconsensual','copyright','spam','other'].includes(reason)) fail(400,'Недопустимая причина.');
    if(!db.reports.some(r=>r.postId===report[1]&&r.userId===me.id))db.reports.push({id:randomUUID(),userId:me.id,postId:report[1],reason,createdAt:Date.now()});
    save();return reply(res,200,{ok:true});
  }
  if(route.startsWith('/admin/')) {
    if(!ADMIN_IDS.has(me.id)) fail(403,'Недостаточно прав.');
    if(method==='GET' && route==='/admin/posts') return reply(res,200,{ posts:db.posts.filter(p=>p.status==='pending').map(p=>publicPost(p,me)), reportedPosts:[...new Set(db.reports.map(r=>r.postId))].map(id=>db.posts.find(p=>p.id===id)).filter(Boolean).map(p=>publicPost(p,me)), reports:db.reports });
    const moderate=route.match(/^\/admin\/posts\/([\w-]+)\/moderate$/);
    if(moderate && method==='POST') {
      const p=db.posts.find(p=>p.id===moderate[1]);if(!p) fail(404,'Публикация не найдена.');
      const body=await getJson(req);if(!['approved','rejected'].includes(body.status))fail(400,'Недопустимый статус.');
      p.status=body.status;db.reports=db.reports.filter(r=>r.postId!==p.id);save();return reply(res,200,{post:publicPost(p,me)});
    }
  }
  fail(404,'API-маршрут не найден.');
}
function pseudo(id) { let n=0;for(const char of id)n=(n*31+char.charCodeAt(0))|0;return n; }
function statics(req,res,pathname) {
  const isMedia=pathname.startsWith('/media/');
  const base=isMedia?UPLOADS:PUBLIC;
  const route=isMedia?pathname.slice(7):pathname==='/'?'index.html':pathname.slice(1);
  const full=path.resolve(base,route);
  if(!full.startsWith(base+path.sep)) {res.writeHead(403);res.end();return;}
  let info;try{info=fs.statSync(full)}catch{res.writeHead(404);res.end('Not found');return;}
  if(!info.isFile()){res.writeHead(404);res.end();return;}
  const ext=path.extname(full).toLowerCase();
  const type=isMedia?({'.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'}[ext]||'application/octet-stream'):MIME[ext]||'application/octet-stream';
  const headers={ 'Content-Type':type,'Cache-Control':isMedia?'public, max-age=86400':'no-store','X-Content-Type-Options':'nosniff', 'Accept-Ranges':isMedia?'bytes':'none' };
  let start=0,end=info.size-1,status=200;
  if(isMedia && req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!match){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}
    if(match[1])start=Number(match[1]);
    if(match[2])end=Number(match[2]);
    if(!match[1] && match[2])start=Math.max(0,info.size-Number(match[2]));
    if(start> end||start>=info.size||!Number.isFinite(start)||!Number.isFinite(end)){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}
    end=Math.min(end,info.size-1);
    headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;status=206;
  }
  headers['Content-Length']=end-start+1;
  res.writeHead(status,headers);
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(full,{start,end}).pipe(res);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: https://t.me https://*.telegram.org; media-src 'self' blob:; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'");
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/health') return reply(res,200,{ok:true});
    if(url.pathname==='/api/public-config') return reply(res,200,{botUsername:process.env.BOT_USERNAME||''});
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    if(req.method!=='GET' && req.method!=='HEAD') return reply(res,405,{error:'Метод не поддерживается.'});
    return statics(req,res,decodeURIComponent(url.pathname));
  } catch(err) {
    const status=err.status||500;
    if(status>=500) console.error('[server]',err);
    if(!res.headersSent) reply(res,status,{error:status>=500?'Внутренняя ошибка сервера.':err.message});
  }
});

async function telegram(method,body) {
  const res=await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json(); if(!data.ok)throw new Error(`Telegram ${method}: ${data.description}`);return data.result;
}
async function pollTelegram(){
  if(!TOKEN || !process.env.WEBAPP_URL) {console.log('Telegram polling disabled: set BOT_TOKEN and WEBAPP_URL to enable /start.');return;}
  if(!process.env.WEBAPP_URL.startsWith('https://')) {console.warn('WEBAPP_URL must use HTTPS. Telegram polling disabled.');return;}
  console.log('Telegram bot polling started');
  while(true){
    try{
      const updates=await telegram('getUpdates',{offset:db.botOffset||0,timeout:25,allowed_updates:['message']});
      for(const item of updates){
        db.botOffset=item.update_id+1;save();
        if(!item.message?.text?.startsWith('/start')&&!item.message?.text?.startsWith('/help'))continue;
        await telegram('sendMessage',{chat_id:item.message.chat.id,text:'SlutSearch <3\nПоиск по тегам, публикации, закладки и плейлисты. Открой Mini App ниже.',reply_markup:{inline_keyboard:[[{text:'Открыть SlutSearch',web_app:{url:process.env.WEBAPP_URL}}]]}});
      }
    }catch(e){console.warn('Telegram bot polling:',e.message);await new Promise(r=>setTimeout(r,4000));}
  }
}
server.listen(PORT,()=>console.log(`SlutSearch MVP: http://localhost:${PORT}${DEV_AUTH?' (DEV_AUTH enabled)':''}`));
void pollTelegram();
