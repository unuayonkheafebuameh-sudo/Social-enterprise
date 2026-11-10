const catalogue=[{id:"1",name:"Featured Product",price:0},{id:"4",name:"Community Product",price:0}];
let basket=[];
const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat("en-NG",{style:"currency",currency:"NGN"}).format(n);
const toggle=o=>{$("drawer").classList.toggle("open",o);$("ov").classList.toggle("open",o)};
function render(){
  $("count").textContent=basket.reduce((s,i)=>s+i.qty,0);
  $("total").textContent=money(basket.reduce((s,i)=>s+i.price*i.qty,0));
  $("items").innerHTML=basket.length?basket.map(i=>`<div class="ci"><div><strong>${i.name}</strong><small>${i.qty} × ${money(i.price)}</small></div><button data-rm="${i.id}">Remove</button></div>`).join(""):'<div class="empty">Your basket is empty. Add an item from the catalogue.</div>';
}
document.querySelectorAll(".plus[data-id]").forEach(b=>b.addEventListener("click",()=>{
  const p=catalogue.find(c=>c.id===b.dataset.id);if(!p)return;
  const e=basket.find(i=>i.id===p.id);e?e.qty++:basket.push({...p,qty:1});render();toggle(true);
}));
$("items").addEventListener("click",e=>{const b=e.target.closest("[data-rm]");if(b){basket=basket.filter(i=>i.id!==b.dataset.rm);render()}});
$("openBag").onclick=()=>toggle(true);$("closeBag").onclick=()=>toggle(false);$("ov").onclick=()=>toggle(false);
document.addEventListener("keydown",e=>{if(e.key==="Escape")toggle(false)});
$("checkout").onclick=()=>alert(basket.length?"Demonstration basket only. Connect a secure backend and verified payment gateway before accepting money.":"Your basket is empty.");
const tabs=document.querySelectorAll(".tab"),cards=document.querySelectorAll(".item");
tabs.forEach(t=>t.addEventListener("click",()=>{
  tabs.forEach(x=>x.classList.remove("on"));t.classList.add("on");
  cards.forEach(c=>c.hidden=!(t.dataset.f==="all"||c.dataset.c===t.dataset.f));
}));
const links=$("links"),burger=$("burger");
burger.onclick=()=>{const s=links.classList.toggle("show");burger.textContent=s?"×":"☰";burger.setAttribute("aria-expanded",s)};
links.querySelectorAll("a").forEach(a=>a.onclick=()=>{links.classList.remove("show");burger.textContent="☰"});
$("year").textContent=new Date().getFullYear();
render();
