'use strict';

// ── State ─────────────────────────────────────────────────────
let currentUser     = null;
let currentMemberId = null;
let currentMemberName = '';
let currentFolderId = null;
let currentFolderName = '';

// ── DOM ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const viewAuth   = $('view-auth');
const viewHome   = $('view-home');
const viewMember = $('view-member');
const viewFolder = $('view-folder');

// ── PDF.js ────────────────────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js';
}

// ── Views ─────────────────────────────────────────────────────
function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  view.classList.add('active');
  window.scrollTo(0, 0);
}

// ── Helpers ───────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '';
  const s = iso.includes('T') ? iso : iso + 'Z';
  return new Date(s).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true });
}
function formatSize(b) {
  return b < 1024 ? b+' B' : b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';
}
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function getInitials(n) { return n.trim().split(/\s+/).slice(0,2).map(w=>w[0].toUpperCase()).join(''); }

const AVATAR_COLORS = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6'];
function avatarColor(name) { let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))%AVATAR_COLORS.length; return AVATAR_COLORS[h]; }

function getFileIcon(mime, name) {
  const ext = (name.split('.').pop()||'').toLowerCase();
  if (/^image\//.test(mime)||['jpg','jpeg','png','gif','webp','heic','heif'].includes(ext)) return {emoji:'&#128444;&#65039;',cls:'img'};
  if (mime==='application/pdf'||ext==='pdf') return {emoji:'&#128196;',cls:'pdf'};
  if (['doc','docx'].includes(ext)||/word/.test(mime)) return {emoji:'&#128209;',cls:'doc'};
  if (['xls','xlsx'].includes(ext)||/sheet|excel/.test(mime)) return {emoji:'&#128202;',cls:'doc'};
  if (mime.startsWith('video/')||['mp4','mov','avi','mkv'].includes(ext)) return {emoji:'&#127916;',cls:'video'};
  return {emoji:'&#128196;',cls:''};
}

let toastTimer = null;
function showToast(msg, type='') {
  const t=$('toast'); t.textContent=msg; t.className=`toast${type?' '+type:''}`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>{ t.className='toast hidden'; },3000);
}

async function api(method, path, body) {
  const token = localStorage.getItem('fs_token');
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body && !(body instanceof FormData)) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  else if (body instanceof FormData) opts.body = body;
  const res = await fetch(path, opts);
  if (res.status === 401) { currentUser = null; localStorage.removeItem('fs_token'); showView(viewAuth); throw new Error('Session expired'); }
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error || 'Request failed'); }
  return res.json();
}

// ══ AUTH ══════════════════════════════════════════════════════
let authMode = 'login';

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab===authMode));
    $('btn-auth-submit').textContent = authMode==='login' ? 'Sign In' : 'Create Account';
    $('auth-username-wrap').classList.toggle('hidden', authMode==='login');
    $('auth-password-confirm-wrap').classList.toggle('hidden', authMode==='login');
    $('auth-error').classList.add('hidden');
  });
});

$('form-auth').addEventListener('submit', async e => {
  e.preventDefault();
  const email    = $('auth-email').value.trim();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  const confirm  = $('auth-password-confirm').value;
  const errEl = $('auth-error');
  errEl.classList.add('hidden');

  if (!email || !password) { errEl.textContent='Please fill in all fields'; errEl.classList.remove('hidden'); return; }
  if (authMode==='register' && !username) { errEl.textContent='Please enter your name'; errEl.classList.remove('hidden'); return; }
  if (authMode==='register' && password!==confirm) { errEl.textContent='Passwords do not match'; errEl.classList.remove('hidden'); return; }

  const btn=$('btn-auth-submit'); btn.disabled=true;
  btn.textContent = authMode==='login' ? 'Signing in\u2026' : 'Creating account\u2026';
  try {
    const payload = authMode==='login' ? {email,password} : {email,username,password};
    const user = await api('POST', authMode==='login'?'/api/auth/login':'/api/auth/register', payload);
    if (user.token) localStorage.setItem('fs_token', user.token);
    currentUser=user; $('user-display').textContent=user.username;
    $('auth-email').value=$('auth-username').value=$('auth-password').value=$('auth-password-confirm').value='';
    showView(viewHome); await loadMembers();
  } catch(err) { errEl.textContent=err.message; errEl.classList.remove('hidden'); }
  finally { btn.disabled=false; btn.textContent=authMode==='login'?'Sign In':'Create Account'; }
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('POST','/api/auth/logout'); } catch {}
  localStorage.removeItem('fs_token');
  currentUser=null; currentMemberId=null; currentFolderId=null; showView(viewAuth);
});

// ══ MEMBERS ═══════════════════════════════════════════════════
function openAddMemberModal() {
  $('input-member-name').value=''; $('input-member-relation').value='';
  openModal('modal-add-member');
  setTimeout(()=>$('input-member-name').focus(),100);
}
$('btn-add-member').addEventListener('click', openAddMemberModal);
$('btn-add-member-empty').addEventListener('click', openAddMemberModal);

$('form-add-member').addEventListener('submit', async e => {
  e.preventDefault();
  const name     = $('input-member-name').value.trim();
  const relation = $('input-member-relation').value;
  if (!name) { $('input-member-name').focus(); return; }
  try {
    await api('POST','/api/members',{name,relation});
    closeModal('modal-add-member');
    showToast(`${name} added \u2713`,'success');
    await loadMembers();
  } catch(err) { showToast(err.message,'error'); }
});

$('btn-back-home').addEventListener('click', () => { showView(viewHome); loadMembers(); });

$('btn-delete-member').addEventListener('click', async () => {
  if (!currentMemberId) return;
  if (!confirm(`Delete "${currentMemberName}" and ALL their folders and files? This cannot be undone.`)) return;
  try {
    await api('DELETE',`/api/members/${currentMemberId}`);
    showView(viewHome); currentMemberId=null; showToast('Member deleted'); await loadMembers();
  } catch(err) { showToast(err.message,'error'); }
});

async function loadMembers() {
  const list=$('members-list'), empty=$('empty-state');
  try {
    const members = await api('GET','/api/members');
    list.innerHTML='';
    if (!members.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    members.forEach(m => {
      const color = avatarColor(m.name);
      const card = document.createElement('div');
      card.className='member-card'; card.setAttribute('role','button'); card.setAttribute('tabindex','0');
      card.innerHTML=`
        <div class="member-avatar" style="background:${color}">${getInitials(m.name)}</div>
        <div class="member-info">
          <div class="member-name">${escHtml(m.name)}</div>
          <div class="member-meta">${m.relation?escHtml(m.relation)+' &nbsp;&middot;&nbsp; ':''} ${m.folder_count} folder${m.folder_count!==1?'s':''}</div>
        </div>
        <span class="member-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>`;
      const open = () => openMember(m.id, m.name, m.relation||'');
      card.addEventListener('click', open);
      card.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' ') open(); });
      list.appendChild(card);
    });
  } catch(err) { showToast('Failed to load members','error'); }
}

function openMember(id, name, relation) {
  currentMemberId=id; currentMemberName=name;
  $('member-name').textContent=name;
  const relBadge=$('member-relation'); relBadge.textContent=relation; relBadge.style.display=relation?'':'none';
  showView(viewMember); loadFolders();
}

// ══ FOLDERS ═══════════════════════════════════════════════════
$('btn-add-folder').addEventListener('click', () => {
  $('input-folder-name').value='';
  openModal('modal-add-folder');
  setTimeout(()=>$('input-folder-name').focus(),100);
});

$('form-add-folder').addEventListener('submit', async e => {
  e.preventDefault();
  const name=$('input-folder-name').value.trim();
  if (!name) { $('input-folder-name').focus(); return; }
  try {
    await api('POST',`/api/members/${currentMemberId}/folders`,{name});
    closeModal('modal-add-folder');
    showToast(`"${name}" created \u2713`,'success');
    await loadFolders();
  } catch(err) { showToast(err.message,'error'); }
});

$('btn-back-member').addEventListener('click', () => { showView(viewMember); loadFolders(); });

$('btn-delete-folder').addEventListener('click', async () => {
  if (!currentFolderId) return;
  if (!confirm(`Delete folder "${currentFolderName}" and all its files? This cannot be undone.`)) return;
  try {
    await api('DELETE',`/api/members/${currentMemberId}/folders/${currentFolderId}`);
    showView(viewMember); currentFolderId=null; showToast('Folder deleted'); await loadFolders();
  } catch(err) { showToast(err.message,'error'); }
});

async function loadFolders() {
  if (!currentMemberId) return;
  const list=$('folders-list'), empty=$('folders-empty');
  try {
    const folders = await api('GET',`/api/members/${currentMemberId}/folders`);
    list.innerHTML='';
    if (!folders.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    const FOLDER_COLORS = ['#fbbf24','#34d399','#60a5fa','#f472b6','#a78bfa','#fb923c'];
    folders.forEach((f,i) => {
      const col = FOLDER_COLORS[i % FOLDER_COLORS.length];
      const card=document.createElement('div'); card.className='folder-card';
      card.setAttribute('role','button'); card.setAttribute('tabindex','0');
      card.innerHTML=`
        <div class="folder-icon" style="color:${col}">&#128193;</div>
        <div class="folder-card-name">${escHtml(f.name)}</div>
        <div class="folder-card-meta">${f.file_count} file${f.file_count!==1?'s':''}</div>`;
      const open=()=>openFolder(f.id,f.name);
      card.addEventListener('click',open);
      card.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' ') open(); });
      list.appendChild(card);
    });
  } catch(err) { showToast('Failed to load folders','error'); }
}

function openFolder(id, name) {
  currentFolderId=id; currentFolderName=name;
  $('folder-name').textContent=name;
  $('folder-breadcrumb').textContent=currentMemberName;
  showView(viewFolder); loadFiles();
}

// ══ FILES ═════════════════════════════════════════════════════
async function loadFiles() {
  if (!currentMemberId||!currentFolderId) return;
  const list=$('files-list'), empty=$('files-empty');
  try {
    const files = await api('GET',`/api/members/${currentMemberId}/folders/${currentFolderId}/files`);
    list.innerHTML=''; $('file-count-badge').textContent=files.length;
    if (!files.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    files.forEach(f => {
      const {emoji,cls}=getFileIcon(f.mime_type,f.original_name);
      const card=document.createElement('div'); card.className='file-card';
      card.innerHTML=`
        <div class="file-type-icon ${cls}">${emoji}</div>
        <div class="file-info">
          <div class="file-name" title="${escHtml(f.original_name)}">${escHtml(f.original_name)}</div>
          <div class="file-date">&#128197; ${formatDate(f.uploaded_at)} &nbsp;&middot;&nbsp; ${formatSize(f.size)}</div>
          ${f.note?`<div class="file-note">&#128172; ${escHtml(f.note)}</div>`:''}
        </div>
        <div class="file-actions">
          <button class="btn-icon btn-preview-file" data-url="${escHtml(f.url)}" data-name="${escHtml(f.original_name)}" data-mime="${escHtml(f.mime_type)}" title="Preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="btn-icon danger btn-del-file" data-id="${escHtml(f.id)}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>`;
      list.appendChild(card);
    });
    list.querySelectorAll('.btn-preview-file').forEach(btn=>{
      btn.addEventListener('click',()=>openPreview({url:btn.dataset.url,originalName:btn.dataset.name,mimeType:btn.dataset.mime}));
    });
    list.querySelectorAll('.btn-del-file').forEach(btn=>{
      btn.addEventListener('click', async()=>{
        if (!confirm('Delete this file?')) return;
        try { await api('DELETE',`/api/members/${currentMemberId}/folders/${currentFolderId}/files/${btn.dataset.id}`); showToast('File deleted'); await loadFiles(); }
        catch(err) { showToast(err.message,'error'); }
      });
    });
  } catch(err) { showToast('Failed to load files','error'); }
}

// ══ PREVIEW ═══════════════════════════════════════════════════
function openPreview(file) {
  const body=$('preview-body');
  $('preview-filename').textContent=file.originalName;
  $('preview-download-btn').href=file.url;
  $('preview-download-btn').setAttribute('download',file.originalName);
  body.innerHTML='';
  $('modal-preview').classList.remove('hidden');
  document.body.style.overflow='hidden';
  const ext=(file.originalName.split('.').pop()||'').toLowerCase();
  const mime=file.mimeType||'';
  if (/^image\//.test(mime)||['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) {
    const img=document.createElement('img'); img.src=file.url; img.className='preview-img'; img.alt=file.originalName; body.appendChild(img);
  } else if (mime==='application/pdf'||ext==='pdf') {
    renderPDF(file.url,body);
  } else {
    body.innerHTML=`<div class="preview-unsupported"><div class="preview-unsupported-icon">&#128196;</div><p>Preview not available.</p><a href="${escHtml(file.url)}" download="${escHtml(file.originalName)}" class="btn btn-primary">Download File</a></div>`;
  }
}

async function renderPDF(url,container) {
  container.innerHTML='<div class="preview-loading"><div class="preview-spinner"></div><p>Loading PDF\u2026</p></div>';
  try {
    const pdf=await pdfjsLib.getDocument(url).promise;
    const wrapper=document.createElement('div'); wrapper.className='pdf-pages';
    container.innerHTML=''; container.appendChild(wrapper);
    for (let n=1;n<=pdf.numPages;n++) {
      const page=await pdf.getPage(n);
      const cw=container.clientWidth||320;
      const uv=page.getViewport({scale:1});
      const scale=(cw/uv.width)*(window.devicePixelRatio||1);
      const vp=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=vp.width; canvas.height=vp.height; canvas.style.width='100%'; canvas.style.display='block';
      const wrap=document.createElement('div'); wrap.className='pdf-page-wrap'; wrap.appendChild(canvas);
      if (pdf.numPages>1) { const lbl=document.createElement('div'); lbl.className='pdf-page-label'; lbl.textContent=`Page ${n} of ${pdf.numPages}`; wrap.appendChild(lbl); }
      wrapper.appendChild(wrap);
      await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    }
  } catch {
    container.innerHTML=`<div class="preview-unsupported"><p>Could not render PDF.</p><a href="${escHtml(url)}" download class="btn btn-primary">Download instead</a></div>`;
  }
}

function closePreview() {
  $('modal-preview').classList.add('hidden'); $('preview-body').innerHTML=''; document.body.style.overflow='';
}
$('btn-close-preview').addEventListener('click',closePreview);

// ══ UPLOAD ════════════════════════════════════════════════════
let selectedFile=null;
const dropZone=$('drop-zone'), fileInput=$('file-input'), dropInner=$('drop-inner'), dropPreview=$('drop-preview');

$('btn-upload').addEventListener('click',()=>{
  selectedFile=null; fileInput.value=''; $('input-note').value='';
  dropInner.classList.remove('hidden'); dropPreview.classList.add('hidden');
  $('btn-submit-upload').disabled=true; $('upload-progress').classList.add('hidden'); $('progress-bar').style.width='0%';
  openModal('modal-upload');
});

dropZone.addEventListener('click',()=>fileInput.click());
dropZone.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' ') fileInput.click(); });
fileInput.addEventListener('change',()=>{ if(fileInput.files[0]) setSelectedFile(fileInput.files[0]); });
dropZone.addEventListener('dragover',e=>{ e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop',e=>{ e.preventDefault(); dropZone.classList.remove('drag-over'); if(e.dataTransfer.files[0]) setSelectedFile(e.dataTransfer.files[0]); });

function setSelectedFile(file) {
  selectedFile=file;
  $('preview-name').textContent=file.name; $('preview-size').textContent=formatSize(file.size);
  $('preview-icon').innerHTML=getFileIcon(file.type,file.name).emoji;
  dropInner.classList.add('hidden'); dropPreview.classList.remove('hidden'); $('btn-submit-upload').disabled=false;
}
$('btn-clear-file').addEventListener('click',e=>{ e.stopPropagation(); selectedFile=null; fileInput.value=''; dropInner.classList.remove('hidden'); dropPreview.classList.add('hidden'); $('btn-submit-upload').disabled=true; });

$('form-upload').addEventListener('submit', async e=>{
  e.preventDefault();
  if (!selectedFile||!currentMemberId||!currentFolderId) return;
  const fd=new FormData(); fd.append('file',selectedFile); fd.append('note',$('input-note').value.trim());
  const btn=$('btn-submit-upload'), prog=$('upload-progress'), bar=$('progress-bar');
  btn.disabled=true; prog.classList.remove('hidden');
  try {
    await uploadXHR(`/api/members/${currentMemberId}/folders/${currentFolderId}/upload`,fd,p=>{ bar.style.width=p+'%'; });
    closeModal('modal-upload'); showToast('File uploaded \u2713','success'); await loadFiles();
  } catch(err) { showToast(err.message||'Upload failed','error'); btn.disabled=false; prog.classList.add('hidden'); }
});

function uploadXHR(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const token = localStorage.getItem('fs_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.addEventListener('progress', e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); });
    xhr.addEventListener('load', () => { if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText)); else { try { reject(new Error(JSON.parse(xhr.responseText).error)); } catch { reject(new Error('Upload failed')); } } });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send(fd);
  });
}

// ══ MODALS ════════════════════════════════════════════════════
function openModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow='hidden'; }
function closeModal(id) { $(id).classList.add('hidden'); document.body.style.overflow=''; }
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{ if(e.target===o) closeModal(o.id); }));
document.querySelectorAll('[data-dismiss]').forEach(btn=>btn.addEventListener('click',()=>closeModal(btn.dataset.dismiss)));
document.addEventListener('keydown',e=>{
  if(e.key==='Escape') {
    if(!$('modal-preview').classList.contains('hidden')) { closePreview(); return; }
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m=>closeModal(m.id));
  }
});

// ══ SERVICE WORKER ════════════════════════════════════════════
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});

// ══ INIT ══════════════════════════════════════════════════════
async function init() {
  if (!localStorage.getItem('fs_token')) { showView(viewAuth); return; }
  try {
    const user = await api('GET', '/api/auth/me');
    currentUser = user; $('user-display').textContent = user.username;
    showView(viewHome); await loadMembers();
  } catch { showView(viewAuth); }
}
init();
