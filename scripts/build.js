const fs=require('fs'),P=require('path'),VB=require('../assets/blocks.js'),{E}=VB;
const R=P.join(__dirname,'..'),D=P.join(R,'dist');
const J=f=>JSON.parse(fs.readFileSync(P.join(R,f),'utf8'));
const site=J('data/site.json'),base=(site.base||'').replace(/\/$/,''),origin=site.url.replace(/\/$/,'');
const U=p=>!p?'':/^(https?:|data:)/.test(p)?p:base+'/'+p.replace(/^\//,'');
const abs=p=>{const u=U(p);return u.startsWith('http')?u:origin+u};
const w=(f,c)=>{fs.mkdirSync(P.dirname(P.join(D,f)),{recursive:true});fs.writeFileSync(P.join(D,f),c)};
const RESERVED=['admin','assets','data','uploads','scripts','dist'];
fs.rmSync(D,{recursive:true,force:true});
for(const d of['assets','admin','uploads'])fs.existsSync(P.join(R,d))&&fs.cpSync(P.join(R,d),P.join(D,d),{recursive:true});
if(fs.existsSync(P.join(R,'CNAME')))fs.copyFileSync(P.join(R,'CNAME'),P.join(D,'CNAME'));
fs.writeFileSync(P.join(D,'.nojekyll'),'');
const members=fs.readdirSync(P.join(R,'data/members')).filter(f=>f.endsWith('.json')).map(f=>J('data/members/'+f))
 .filter(m=>!m.hidden&&m.slug&&!RESERVED.includes(m.slug)).sort((a,b)=>(a.order||0)-(b.order||0));
const shell=({title,desc,path,img,ld,body,noindex})=>`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(title)}</title><meta name="description" content="${E(desc)}">${noindex?'<meta name="robots" content="noindex">':`<link rel="canonical" href="${origin}${path}">`}<meta property="og:title" content="${E(title)}"><meta property="og:description" content="${E(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${origin}${path}">${img?`<meta property="og:image" content="${E(abs(img))}">`:''}<meta name="twitter:card" content="summary_large_image">${site.verify?.google?`<meta name="google-site-verification" content="${E(site.verify.google)}">`:''}${site.verify?.bing?`<meta name="msvalidate.01" content="${E(site.verify.bing)}">`:''}<link rel="stylesheet" href="${base}/assets/style.css"><style>:root{--ac:${E(site.accent)}}</style>${ld?`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>`:''}</head><body><header class="top"><a class="brand" href="${base}/">${E(site.name)}</a></header><main>${body}</main><footer>${E(site.footer)}</footer></body></html>`;
const cards=members.map(m=>`<a class="card" href="${base}/${m.slug}/" data-s="${E((m.name+' '+(m.tags||[]).join(' ')+' '+m.role).toLowerCase())}">${m.avatar?`<img src="${E(U(m.avatar))}" alt="${E(m.name)}" loading="lazy">`:'<span class="ava"></span>'}<strong>${E(m.name)}</strong><br><small>${E(m.role)}</small><br>${(m.tags||[]).map(t=>`<span class="tag">${E(t)}</span>`).join('')}</a>`).join('');
w('index.html',shell({title:`${site.name} - ${site.tagline}`,desc:site.description,path:'/',img:site.ogImage,
 ld:{'@context':'https://schema.org','@type':'Organization',name:site.name,url:origin+'/',description:site.description,member:members.map(m=>({'@type':'Person',name:m.name,url:`${origin}/${m.slug}/`}))},
 body:`<div class="hero"><h1>${E(site.name)}</h1><p>${E(site.tagline)}</p></div><div class="tools"><input id="q" type="search" placeholder="Tìm thành viên..." aria-label="Tìm thành viên"></div><div class="grid" id="g">${cards}</div><script>q.oninput=()=>{const v=q.value.toLowerCase();document.querySelectorAll('#g .card').forEach(c=>c.hidden=!c.dataset.s.includes(v))}</script>`}));
for(const m of members){
 const body=`<div class="hero">${m.avatar?`<img class="ava" src="${E(U(m.avatar))}" alt="${E(m.name)}">`:''}<h1>${E(m.name)}</h1><p>${E(m.role)}</p></div>${(m.blocks||[]).map(b=>VB.render(b,U)).join('')}`;
 w(`${m.slug}/index.html`,shell({title:`${m.name} - ${site.name}`,desc:m.summary||`${m.name} - ${m.role} thuộc ${site.name}`,path:`/${m.slug}/`,img:m.ogImage||m.avatar,
  ld:{'@context':'https://schema.org','@type':'Person',name:m.name,jobTitle:m.role,url:`${origin}/${m.slug}/`,image:m.avatar?abs(m.avatar):undefined,memberOf:{'@type':'Organization',name:site.name},sameAs:(m.blocks||[]).filter(b=>b.type==='button'&&/^https?:/.test(b.url)).map(b=>b.url)},body}));}
w('404.html',shell({title:`Không tìm thấy trang - ${site.name}`,desc:'404',path:'/404.html',noindex:1,body:`<div class="hero"><h1>404</h1><p>Trang này không tồn tại.</p><a href="${base}/">Về trang chủ</a></div>`}));
const day=new Date().toISOString().slice(0,10);
w('sitemap.xml',`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['',...members.map(m=>m.slug+'/')].map(p=>`<url><loc>${origin}/${p}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>`);
w('robots.txt',`User-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${origin}/sitemap.xml\n`);
console.log('Đã build',members.length,'thành viên');
