/* SlutSearch <3 — Telegram Mini App client. No external framework needed. */
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
const $ = (id) => document.getElementById(id);
const state = { me:null, config:null, route:'home', tags:[], media:'all',sort:'latest',layout:'grid',excludeAI:false,
  home:{posts:[],nextOffset:null,total:0}, hot:{posts:[],nextOffset:null,total:0},hotSort:'views',
  profileTab:'posts', profilePosts:[], profileBookmarks:[], playlists:[], currentPlaylist:null, activePost:null, ageOK:false };
const html = (str) => String(str??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const debounce = (fn,wait=200)=>{let t;return (...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),wait)}};
const letter = value=>(value||'S').slice(0,1).toUpperCase();
let toastTimer;
function toast(message){const e=$('toast');e.textContent=message;e.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('visible'),3100)}
function setAvatar(el,user){if(!el)return;el.textContent=letter(user?.displayName);if(user?.avatar && /^https:\/\//.test(user.avatar)){el.style.backgroundImage=`url(${JSON.stringify(user.avatar).slice(1,-1)})`;el.textContent='';}else el.style.backgroundImage='';}
async function request(path,{method='GET',data,form}={}){
  const headers = {};
  if(tg?.initData) headers.Authorization='tma '+tg.initData;
  if(data!==undefined)headers['Content-Type']='application/json';
  let response;
  try {response=await fetch('/api'+path,{method,headers,body:form??(data!==undefined?JSON.stringify(data):undefined)});}catch{throw new Error('Нет связи с сервером.');}
  let value;try{value=await response.json();}catch{value={error:'Сервер вернул неизвестный ответ.'};}
  if(!response.ok)throw new Error(value.error||`Ошибка ${response.status}`);
  return value;
}
function showModal(title,markup){$('modalTitle').textContent=title;$('modalBody').innerHTML=markup;$('modalBackdrop').classList.remove('hidden');}
function hideModal(){$('modalBackdrop').classList.add('hidden');$('modalBody').innerHTML='';state.activePost=null;}
function closeSidebar(){$('sidebar').classList.remove('open');$('sidebar').setAttribute('aria-hidden','true');$('sideBackdrop').classList.add('hidden')}
function openSidebar(){$('sidebar').classList.add('open');$('sidebar').setAttribute('aria-hidden','false');$('sideBackdrop').classList.remove('hidden')}
async function routeTo(route){
  closeSidebar();hideModal();
  if(route==='login')return login();
  if(!['home','hot','playlists','profile','upload'].includes(route))return;
  state.route=route;
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+route));
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.route===route));
  window.scrollTo({top:0,behavior:'instant'});
  try{
    if(route==='home')await loadHome();
    if(route==='hot')await loadHot();
    if(route==='playlists')await loadPlaylists();
    if(route==='profile')await loadProfile();
  }catch(e){toast(e.message)}
}
function login(){
  const logged=!!state.me;
  const bot=state.config?.botUsername;
  showModal(logged?'Telegram account':'Login',`<p>${logged?`Ты вошёл(вошла) как <strong>${html(state.me.displayName)}</strong> через Telegram.`:'Для входа открой Mini App из Telegram-бота.'}</p>${bot?`<p><a href="https://t.me/${encodeURIComponent(bot)}" target="_blank" rel="noopener">@${html(bot)} в Telegram</a></p>`:''}<button class="primary full" id="modalOk">OK</button>`);
  $('modalOk').onclick=hideModal;
}
function bindOptions(containerId,current,onSelect){
  $(containerId).querySelectorAll('[data-value]').forEach(b=>{
    b.classList.toggle('chosen',b.dataset.value===current);
    b.onclick=()=>{onSelect(b.dataset.value);bindOptions(containerId,b.dataset.value,onSelect)};
  });
}
function renderSelectedTags(){
  $('searchTags').innerHTML=state.tags.map(t=>`<button class="chip" data-tag-remove="${html(t)}">#${html(t)} <small>×</small></button>`).join('');
  $('tagCounter').textContent=`${state.tags.length} / 5`;
}
function addTag(value){
  const tag=String(value||'').trim().replace(/^#+/,'').replace(/\s+/g,' ').toLowerCase();
  if(!tag)return;
  if(tag.length>40 || /[<>\x00-\x1f]/.test(tag))return toast('Некорректный тег. Максимум 40 символов.');
  if(state.tags.includes(tag)){$('tagInput').value='';return;}
  if(state.tags.length>=5)return toast('Максимум 5 тегов для поиска.');
  state.tags.push(tag);$('tagInput').value='';renderSelectedTags();loadHome().catch(e=>toast(e.message));
}
function removeTag(tag){state.tags=state.tags.filter(t=>t!==tag);renderSelectedTags();loadHome().catch(e=>toast(e.message));}
async function loadTags(){
  const {tags}=await request('/tags');
  if(!tags.length){$('hotTags').innerHTML='<span style="color:#8099b3;font-size:13px">Популярные теги появятся после первых публикаций.</span>';$('expandTags').classList.add('hidden');return;}
  let showAll=false;
  const render=()=>{
    $('hotTags').innerHTML=tags.slice(0,showAll?20:9).map(t=>`<button class="chip" data-hot-tag="${html(t.name)}">${html(t.name)}</button>`).join('');
    $('expandTags').textContent=showAll?'Show less':`Show more (+${Math.max(tags.length-9,0)})`;
    $('expandTags').classList.toggle('hidden',tags.length<=9);
  };
  $('expandTags').onclick=()=>{showAll=!showAll;render()};render();
}
function emptyGallery(message='Пока ничего нет',desc='Начни с загрузки изображения или видео.'){
  return `<div class="empty"><div class="empty-symbol">✳</div><strong>${html(message)}</strong><p>${html(desc)}</p><button class="primary" data-route="upload">+ Upload media</button></div>`;
}
function card(post){
  const src=html(post.mediaUrl),image=post.kind==='video' ? `<video class="post-thumb" src="${src}#t=0.1" preload="metadata" muted playsinline></video>`:`<img class="post-thumb" src="${src}" loading="lazy" alt="${html(post.title)}" />`;
  return `<article class="post-card" data-post="${html(post.id)}"><div class="post-preview" data-open="${html(post.id)}">${image}<div class="badge-float ${post.status==='pending'?'pending':''}">${post.status==='pending'?'Pending review':post.kind==='video'?'▶ Video':post.ai?'✳ AI':'✦ Post'}</div></div><div class="post-meta"><span class="post-title">${html(post.title)}</span><div class="post-tags">${post.tags.map(t=>'#'+html(t)).join(' · ')}</div><div class="post-footer"><span>◉ ${Number(post.views||0)}</span><button class="like-btn ${post.liked?'liked':''}" data-like="${html(post.id)}" title="Like">${post.liked?'♥':'♡'} ${Number(post.likes||0)}</button><button class="bookmark-btn ${post.bookmarked?'saved':''}" data-bookmark="${html(post.id)}" title="Bookmarks" aria-label="${post.bookmarked?'Убрать из закладок':'В закладки'}">${post.bookmarked?'▣':'▢'}</button></div></div></article>`;
}
const allPosts=()=>[...state.home.posts,...state.hot.posts,...state.profilePosts,...state.profileBookmarks,...(state.currentPlaylist?.posts||[])];
function postById(id){return allPosts().find(p=>p.id===id)}
function renderGallery(target,posts,layout='grid',emptyText){const e=$(target);e.classList.toggle('masonry',layout==='masonry');e.innerHTML=posts.length?posts.map(card).join(''):emptyGallery(emptyText||'Пока нет публикаций',target==='homeGallery'?'Попробуй другие теги или загрузи первый пост.':'Здесь появятся изображения и видео.');}
async function loadHome(append=false){
  const q=new URLSearchParams({sort:state.sort,media:state.media,ai:state.excludeAI?'exclude':'all',offset:String(append?state.home.nextOffset||0:0)});
  state.tags.forEach(t=>q.append('tag',t));
  const response=await request('/posts?'+q.toString());
  state.home={posts:append?[...state.home.posts,...response.posts]:response.posts,nextOffset:response.nextOffset,total:response.total};
  renderGallery('homeGallery',state.home.posts,state.layout,state.tags.length?'Ничего не найдено':'Здесь пока пусто');
  $('postCount').textContent=`${response.total}`;$('loadMore').classList.toggle('hidden',response.nextOffset===null);
  loadTags().catch(()=>{});
}
async function loadHot(append=false){
  const q=new URLSearchParams({sort:state.hotSort,offset:String(append?state.hot.nextOffset||0:0)});
  const response=await request('/posts?'+q.toString());
  state.hot={posts:append?[...state.hot.posts,...response.posts]:response.posts,nextOffset:response.nextOffset,total:response.total};
  renderGallery('hotGallery',state.hot.posts,'grid','Пока нет популярных публикаций');
  $('hotLoadMore').classList.toggle('hidden',response.nextOffset===null);
}
async function toggleBookmark(id){
  const post=postById(id);if(!post)return;
  const next=!post.bookmarked;
  try{
    await request(`/posts/${id}/bookmark`,{method:next?'POST':'DELETE'});
    for(const p of allPosts())if(p.id===id)p.bookmarked=next;
    refreshCards();toast(next?'Добавлено в закладки':'Удалено из закладок');
    if(state.route==='profile' && state.profileTab==='bookmarks')await loadProfile();
  }catch(e){toast(e.message)}
}
async function toggleLike(id){
  const post=postById(id);if(!post)return;const next=!post.liked;
  try {const result=await request(`/posts/${id}/like`,{method:next?'POST':'DELETE'});
    for(const p of allPosts())if(p.id===id){p.liked=result.liked;p.likes=result.likes;}
    refreshCards();
  }catch(e){toast(e.message)}
}
function refreshCards(){
  renderGallery('homeGallery',state.home.posts,state.layout);
  renderGallery('hotGallery',state.hot.posts);
  if(state.route==='profile' && state.profileTab!=='playlists')renderGallery('profileGallery',state.profileTab==='posts'?state.profilePosts:state.profileBookmarks);
  if(state.currentPlaylist?.posts)renderGallery('playlistGallery',state.currentPlaylist.posts);
}
async function openPost(id){
  const post=postById(id);if(!post)return toast('Публикация не найдена.');
  state.activePost=post;
  const media=post.kind==='video'?`<video class="modal-media" controls playsinline src="${html(post.mediaUrl)}"></video>`:`<img class="modal-media" alt="${html(post.title)}" src="${html(post.mediaUrl)}" />`;
  showModal(post.title,`${media}<div class="modal-tags">${post.tags.map(t=>`<span>#${html(t)}</span>`).join('')}</div><div class="modal-details">@${html(post.author.username||post.author.name)} · ${post.kind==='video'?'Video':'Image'} · ${post.status==='pending'?'Pending review':'Published'}</div><div class="modal-toolbar"><button class="subtle-btn" id="modalBookmark">${post.bookmarked?'♥ Bookmarked':'♡ Bookmark'}</button><button class="subtle-btn" id="modalPlaylist">+ Playlist</button><button class="subtle-btn" id="modalReport">Report</button></div>`);
  $('modalBookmark').onclick=async()=>{await toggleBookmark(id);hideModal();};
  $('modalPlaylist').onclick=()=>showAddToPlaylist(id);
  $('modalReport').onclick=()=>showReport(id);
  try{const r=await request(`/posts/${id}/view`,{method:'POST'});post.views=r.views;}catch{}
}
async function loadPlaylists(){
  const result=await request('/playlists');state.playlists=result.playlists;
  $('playlistDetail').classList.add('hidden');$('playlistList').classList.remove('hidden');
  renderPlaylists('playlistList');
}
function renderPlaylists(target){
  const e=$(target);
  e.innerHTML=state.playlists.length?state.playlists.map(p=>`<div class="playlist-card"><span class="playlist-icon">▤</span><button class="playlist-card-info" data-playlist-open="${html(p.id)}" style="text-align:left"><strong>${html(p.name)}</strong><small>${p.count} posts</small></button><button class="delete-small" data-playlist-delete="${html(p.id)}" aria-label="Удалить плейлист">×</button></div>`).join(''):emptyGallery('Плейлистов пока нет','Создай свою первую подборку.');
}
async function showPlaylist(id){
  try{
    const data=await request(`/playlists/${id}/posts`);state.currentPlaylist=data;
    state.route='playlists';document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-playlists'));
    $('playlistList').classList.add('hidden');$('playlistDetail').classList.remove('hidden');$('playlistDetailName').textContent=data.playlist.name;
    renderGallery('playlistGallery',data.posts,'grid','В плейлисте пока нет публикаций');
    window.scrollTo(0,0);
  }catch(e){toast(e.message)}
}
function showCreatePlaylist(){
  showModal('Create playlist','<p class="modal-details">Название новой коллекции.</p><input id="newPlaylistName" maxlength="70" placeholder="Playlist name" /><button class="primary full" id="savePlaylist">Create playlist</button>');
  $('savePlaylist').onclick=async()=>{
    try{await request('/playlists',{method:'POST',data:{name:$('newPlaylistName').value}});hideModal();await loadPlaylists();if(state.route==='profile')await loadProfile();toast('Плейлист создан');}catch(e){toast(e.message)}
  };
}
async function showAddToPlaylist(postId){
  try{
    const {playlists}=await request('/playlists');state.playlists=playlists;
    if(!playlists.length){showModal('Add to playlist','<p>Сначала создай плейлист в разделе Playlists.</p><button class="primary full" id="makeOne">Create playlist</button>');$('makeOne').onclick=showCreatePlaylist;return;}
    showModal('Add to playlist',`<p class="modal-details">Выбери коллекцию для публикации.</p><select id="choosePlaylist">${playlists.map(p=>`<option value="${html(p.id)}">${html(p.name)}</option>`).join('')}</select><button class="primary full" id="addToPlaylist">Add post</button>`);
    $('addToPlaylist').onclick=async()=>{try{await request(`/playlists/${$('choosePlaylist').value}/posts`,{method:'POST',data:{postId}});hideModal();toast('Добавлено в плейлист');}catch(e){toast(e.message)}};
  }catch(e){toast(e.message)}
}
function showReport(postId){
  showModal('Report publication','<p class="modal-details">Сообщить модерации о нарушении.</p><select id="reportReason"><option value="underage">Несовершеннолетние</option><option value="nonconsensual">Нет согласия</option><option value="copyright">Нарушение авторских прав</option><option value="spam">Спам</option><option value="other">Другое</option></select><button class="primary full" id="sendReport">Send report</button>');
  $('sendReport').onclick=async()=>{try{await request(`/posts/${postId}/report`,{method:'POST',data:{reason:$('reportReason').value}});hideModal();toast('Жалоба отправлена');}catch(e){toast(e.message)}};
}
async function loadProfile(){
  const result=await request('/me');state.me=result;
  setAvatar($('avatarBtn'),result);setAvatar($('profileAvatar'),result);
  $('profileName').textContent=result.displayName;$('profileHandle').textContent=result.username?'@'+result.username:'Telegram user';
  $('profilePosts').textContent=result.posts;$('profileBookmarks').textContent=result.bookmarks;$('profilePlaylists').textContent=result.playlists;
  await profileTab(state.profileTab);
}
async function profileTab(tab){
  state.profileTab=tab;
  $('profileTabs').querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b.dataset.value===tab));
  $('profileGallery').classList.toggle('hidden',tab==='playlists');$('profilePlaylistList').classList.toggle('hidden',tab!=='playlists');
  if(tab==='playlists'){
    const r=await request('/playlists');state.playlists=r.playlists;renderPlaylists('profilePlaylistList');return;
  }
  const q=new URLSearchParams({source:tab==='bookmarks'?'bookmarks':'all',sort:'latest'});
  if(tab==='posts')q.set('owner',state.me.id);
  const r=await request('/posts?'+q.toString());
  if(tab==='posts')state.profilePosts=r.posts;else state.profileBookmarks=r.posts;
  renderGallery('profileGallery',r.posts,'grid',tab==='bookmarks'?'Закладок ещё нет':'Публикаций пока нет');
}
function showSettings(){if(state.config?.isAdmin)return showAdmin();showModal('Profile settings','<p>Имя и аватар загружаются из Telegram. Чтобы изменить их, открой настройки профиля Telegram.</p><p class="modal-details">SlutSearch не просит твой номер телефона или пароль Telegram.</p><button class="primary full" id="settingsOk">OK</button>');$('settingsOk').onclick=hideModal}
async function showAdmin(){
  try{const {posts,reports,reportedPosts}=await request('/admin/posts');
    const media=p=>p.kind==='video'?`<video controls muted playsinline src="${html(p.mediaUrl)}" style="width:90px;height:85px;object-fit:contain;border-radius:8px;background:#050b12"></video>`:`<img src="${html(p.mediaUrl)}" style="width:90px;height:85px;object-fit:cover;border-radius:8px" alt="Preview"/>`;
    const line=p=>`<div class="playlist-card" style="flex-wrap:wrap">${media(p)}<div class="playlist-card-info"><strong>${html(p.title)}</strong><small>${p.tags.map(html).join(', ')}</small></div><button class="subtle-btn" data-admin-approve="${html(p.id)}">Approve</button><button class="delete-small" data-admin-reject="${html(p.id)}">×</button></div>`;
    const markup=`<p class="modal-details">Pending uploads: ${posts.length}. Reports: ${reports.length}.</p><h3>Pending</h3>`+
      (posts.length?posts.map(line).join(''):'<p>No pending uploads.</p>')+
      '<h3>Reported content</h3>'+(reportedPosts.length?reportedPosts.map(p=>`<p class="modal-details">${html(reports.filter(r=>r.postId===p.id).map(r=>r.reason).join(', '))}</p>`+line(p)).join(''):'<p>No open reports.</p>');
    showModal('Moderation',markup);
    $('modalBody').querySelectorAll('[data-admin-approve],[data-admin-reject]').forEach(b=>b.onclick=async()=>{try{await request(`/admin/posts/${b.dataset.adminApprove||b.dataset.adminReject}/moderate`,{method:'POST',data:{status:b.dataset.adminApprove?'approved':'rejected'}});toast('Moderation updated');showAdmin();}catch(e){toast(e.message)}});
  }catch(e){toast(e.message)}
}
function updateFilePreview(){
  const f=$('mediaFile').files[0];const target=$('mediaPreview');target.innerHTML='';
  if(!f){$('fileLabel').textContent='Choose image or video';return;}
  $('fileLabel').textContent=f.name;if(f.size>50*1024*1024){toast('Файл превышает 50 MB.');return;}
  const url=URL.createObjectURL(f);let el;
  if(f.type.startsWith('image/')){el=document.createElement('img');el.alt='Preview';}
  else{el=document.createElement('video');el.controls=true;el.muted=true;}
  el.src=url;el.onload=el.onloadeddata=()=>URL.revokeObjectURL(url);
  target.append(el);
}
async function upload(event){
  event.preventDefault();
  const tags=$('uploadTags').value.split(',').map(t=>t.trim()).filter(Boolean);
  if(!tags.length||new Set(tags.map(t=>t.toLowerCase())).size>12)return toast('Для загрузки нужно 1–12 уникальных тегов.');
  const file=$('mediaFile').files[0];if(!file)return toast('Выбери файл.');
  const form=new FormData();form.set('file',file);form.set('title',$('uploadTitle').value.trim());form.set('tags',tags.join(','));form.set('ai',String($('uploadAI').checked));
  const button=$('submitUpload');button.disabled=true;button.textContent='Uploading...';
  try{
    const result=await request('/posts',{method:'POST',form});
    $('uploadForm').reset();$('mediaPreview').innerHTML='';$('fileLabel').textContent='Choose image or video';
    toast(result.message);await routeTo('profile');await profileTab('posts');
  }catch(e){toast(e.message)}finally{button.disabled=false;button.textContent='Publish media'}
}
function initEvents(){
  $('menuBtn').onclick=openSidebar;$('sideClose').onclick=closeSidebar;$('sideBackdrop').onclick=closeSidebar;
  $('avatarBtn').onclick=()=>routeTo('profile');$('uploadBtn').onclick=()=>routeTo('upload');
  document.addEventListener('click',e=>{
    const target=e.target.closest('[data-route]');if(target){routeTo(target.dataset.route);return;}
    const hot=e.target.closest('[data-hot-tag]');if(hot){addTag(hot.dataset.hotTag);return;}
    const remove=e.target.closest('[data-tag-remove]');if(remove){removeTag(remove.dataset.tagRemove);return;}
    const bookmark=e.target.closest('[data-bookmark]');if(bookmark){toggleBookmark(bookmark.dataset.bookmark);return;}
    const like=e.target.closest('[data-like]');if(like){toggleLike(like.dataset.like);return;}
    const open=e.target.closest('[data-open]');if(open){openPost(open.dataset.open);return;}
    const playlist=e.target.closest('[data-playlist-open]');if(playlist){showPlaylist(playlist.dataset.playlistOpen);return;}
    const del=e.target.closest('[data-playlist-delete]');if(del){
      if(confirm('Удалить плейлист?')) request(`/playlists/${del.dataset.playlistDelete}`,{method:'DELETE'}).then(()=>{toast('Плейлист удалён');state.route==='profile'?loadProfile():loadPlaylists()}).catch(er=>toast(er.message));return;
    }
  });
  $('modalClose').onclick=hideModal;$('modalBackdrop').onclick=e=>{if(e.target===$('modalBackdrop'))hideModal()};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){hideModal();closeSidebar()}});
  $('addTagBtn').onclick=()=>addTag($('tagInput').value);
  $('tagInput').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();addTag($('tagInput').value)}});
  $('tagInput').addEventListener('blur',()=>{if($('tagInput').value.trim())addTag($('tagInput').value)});
  $('filtersToggle').onclick=()=>{$('filterContent').classList.toggle('collapsed');$('filterChevron').classList.toggle('down')};
  bindOptions('mediaOptions',state.media,value=>{state.media=value;loadHome().catch(e=>toast(e.message))});
  bindOptions('sortOptions',state.sort,value=>{state.sort=value;loadHome().catch(e=>toast(e.message))});
  bindOptions('layoutOptions',state.layout,value=>{state.layout=value;refreshCards()});
  bindOptions('hotSort',state.hotSort,value=>{state.hotSort=value;loadHot().catch(e=>toast(e.message))});
  $('excludeAI').onchange=e=>{state.excludeAI=e.target.checked;loadHome().catch(er=>toast(er.message))};
  $('loadMore').onclick=()=>loadHome(true).catch(e=>toast(e.message));$('hotLoadMore').onclick=()=>loadHot(true).catch(e=>toast(e.message));
  $('createPlaylistBtn').onclick=showCreatePlaylist;$('playlistBack').onclick=()=>loadPlaylists().catch(e=>toast(e.message));
  $('profileTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>profileTab(b.dataset.value).catch(e=>toast(e.message)));
  $('profileSettings').onclick=showSettings;
  $('mediaFile').onchange=updateFilePreview;$('uploadForm').onsubmit=upload;
  $('confirmAge').onclick=()=>{try{localStorage.setItem('slutsearch_age_confirmed','yes')}catch{};$('ageGate').classList.add('hidden');state.ageOK=true;};
}
async function main(){
  initEvents();
  try {state.ageOK=localStorage.getItem('slutsearch_age_confirmed')==='yes'}catch{}
  $('ageGate').classList.toggle('hidden',state.ageOK);
  try {
    const [me,config]=await Promise.all([request('/me'),request('/config')]);
    state.me=me;state.config=config;setAvatar($('avatarBtn'),me);
    if(config.dev)toast('Локальный демонстрационный режим');
    await loadHome();
  }catch(e){
    renderGallery('homeGallery',[]);
    try{state.config=await request('/public-config')}catch{}
    const bot=state.config?.botUsername;
    showModal('Telegram login',`<p>Для входа в SlutSearch открой приложение из Telegram-бота.</p>${bot?`<p><a href="https://t.me/${encodeURIComponent(bot)}" target="_blank" rel="noopener">Открыть @${html(bot)}</a></p>`:''}<p class="modal-details">${html(e.message)}</p><button class="primary full" id="loginOK">OK</button>`);
    $('loginOK').onclick=hideModal;
  }
}
void main();
