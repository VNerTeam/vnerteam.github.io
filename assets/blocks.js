(function(g){
const E=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const HOVERS=[['','Không có'],['grow','Phóng to'],['lift','Nổi lên + bóng'],['glow','Phát sáng neon'],['shine','Quét ánh sáng'],['gradient','Gradient dịch chuyển'],['shake','Rung nhẹ'],['pulse','Tim đập'],['tilt','Nghiêng 3D'],['zoom','Zoom ảnh'],['gray','Xám → màu'],['underline','Gạch chân trượt']];
const TYPES={heading:'Tiêu đề',text:'Đoạn văn',image:'Ảnh',button:'Nút liên kết',youtube:'Video YouTube',html:'HTML tuỳ ý',spacer:'Khoảng cách'};
function yt(u){const m=String(u).match(/(?:v=|youtu\.be\/|embed\/|live\/)([\w-]{11})/);return m?m[1]:''}
function render(b,U){U=U||(x=>x);const s=b.style||{};
const st=E(`background:${s.bg||'transparent'};color:${s.color||'inherit'};text-align:${s.align||'left'};border-radius:${+s.radius||0}px;padding:${+s.pad||0}px`);
const h=b.hover?` vt-hover-${E(b.hover)}`:'';const sp=b.speed?` style="--spd:${+b.speed}s"`:'';let c='';
switch(b.type){
case'heading':c=`<h2>${E(b.text)}</h2>`;break;
case'text':c=b.text||'';break;
case'image':c=b.src?`<img class="${h.trim()}"${sp} src="${E(U(b.src))}" alt="${E(b.alt)}" loading="lazy">`:'';break;
case'button':c=`<a class="vt-btn${h}"${sp} href="${E(b.url)}" rel="noopener">${E(b.text)}</a>`;break;
case'youtube':c=yt(b.url)?`<div class="vt-video"><iframe src="https://www.youtube-nocookie.com/embed/${yt(b.url)}" loading="lazy" allowfullscreen title="${E(b.text||'Video')}"></iframe></div>`:'';break;
case'html':c=b.text||'';break;
case'spacer':c='';break}
return `<section class="vt-block vt-${E(b.type)}" style="${st}">${c}</section>`}
const api={E,HOVERS,TYPES,render};
if(typeof module!=='undefined')module.exports=api;else g.VB=api;
})(this);
