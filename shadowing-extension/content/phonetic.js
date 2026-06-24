(function (root) {
  'use strict';
  function sanitize(text) {
    if (!text) return [];
    return String(text).toLowerCase()
      .replace(/[^a-zäöüß0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  }
  function koelner(word) {
    if (!word) return '';
    const w = String(word).toLowerCase()
      .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'s')
      .replace(/[^a-z]/g,'');
    if (!w) return '';
    const codes = [];
    for (let i=0;i<w.length;i++){
      const c=w[i], next=w[i+1]||' ', prev=w[i-1]||' '; let code=null;
      switch(c){
        case 'a':case 'e':case 'i':case 'j':case 'o':case 'u':case 'y':code='0';break;
        case 'h':code=null;break;
        case 'b':code='1';break;
        case 'p':code=(next==='h')?'3':'1';break;
        case 'd':case 't':code='csz'.includes(next)?'8':'2';break;
        case 'f':case 'v':case 'w':code='3';break;
        case 'g':case 'k':case 'q':code='4';break;
        case 'c':
          if(i===0){code='ahkloqrux'.includes(next)?'4':'8';}
          else if('sz'.includes(prev)){code='8';}
          else{code='ahkoqux'.includes(next)?'4':'8';}
          break;
        case 'x':code='ckq'.includes(prev)?'8':'48';break;
        case 'l':code='5';break;
        case 'm':case 'n':code='6';break;
        case 'r':code='7';break;
        case 's':case 'z':code='8';break;
        default:code=null;
      }
      if(code!==null){for(const d of code)codes.push(d);}
    }
    const dedup=[]; for(const d of codes) if(dedup.length===0||dedup[dedup.length-1]!==d)dedup.push(d);
    return dedup.filter((d,idx)=>idx===0||d!=='0').join('');
  }
  function levenshtein(a,b){a=a||'';b=b||'';const m=a.length,n=b.length;if(!m)return n;if(!n)return m;
    let prev=Array.from({length:n+1},(_,i)=>i),cur=new Array(n+1);
    for(let i=1;i<=m;i++){cur[0]=i;for(let j=1;j<=n;j++){const cost=a[i-1]===b[j-1]?0:1;cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+cost);}[prev,cur]=[cur,prev];}return prev[n];}
  // Ngôn ngữ chấm điểm hiện tại: 'de' dùng mã hoá ngữ âm Kölner; còn lại dùng độ tương tự
  // ký tự tổng quát (Levenshtein chuẩn hoá) để target=en (hoặc khác) vẫn chấm được.
  let SIM_LANG = 'de';
  function setLang(l){ SIM_LANG = (l || 'de').slice(0,2).toLowerCase(); }
  function genericSim(wa,wb){const a=String(wa||'').toLowerCase(),b=String(wb||'').toLowerCase();if(!a&&!b)return 1;const d=levenshtein(a,b);return 1-d/Math.max(a.length,b.length,1);}
  function phoneticSim(wa,wb){
    if(SIM_LANG!=='de') return genericSim(wa,wb);
    const ca=koelner(wa),cb=koelner(wb);if(!ca&&!cb)return 1;const d=levenshtein(ca,cb);return 1-d/Math.max(ca.length,cb.length,1);
  }
  function alignWords(refWords,hypWords){const m=refWords.length,n=hypWords.length,GAP=-0.6;
    const score=Array.from({length:m+1},()=>new Array(n+1).fill(0)),back=Array.from({length:m+1},()=>new Array(n+1).fill(0));
    for(let i=1;i<=m;i++){score[i][0]=i*GAP;back[i][0]=1;}for(let j=1;j<=n;j++){score[0][j]=j*GAP;back[0][j]=2;}
    for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){const match=score[i-1][j-1]+(phoneticSim(refWords[i-1],hypWords[j-1])-0.4);const up=score[i-1][j]+GAP,left=score[i][j-1]+GAP;let best=match,b=0;if(up>best){best=up;b=1;}if(left>best){best=left;b=2;}score[i][j]=best;back[i][j]=b;}
    const pairs=[];let i=m,j=n;while(i>0||j>0){if(i>0&&j>0&&back[i][j]===0){pairs.push({ref:refWords[i-1],hyp:hypWords[j-1]});i--;j--;}else if(i>0&&(j===0||back[i][j]===1)){pairs.push({ref:refWords[i-1],hyp:null});i--;}else{pairs.push({ref:null,hyp:hypWords[j-1]});j--;}}pairs.reverse();return pairs;}
  function classify(r,h){if(h==null)return{status:'missing',sim:0};const sim=phoneticSim(r,h);if(r.toLowerCase()===h.toLowerCase()||sim>=0.999)return{status:'correct',sim:1};if(sim>=0.6)return{status:'near',sim};return{status:'wrong',sim};}
  function analyze(refText,hypText,opts){opts=opts||{};setLang(opts.lang||'de');const refWords=sanitize(refText),hypWords=sanitize(hypText),pairs=alignWords(refWords,hypWords);
    const words=[];let correct=0,near=0,wrong=0,missing=0,extra=0;
    for(const p of pairs){if(p.ref==null){extra++;continue;}const cls=classify(p.ref,p.hyp);if(cls.status==='correct')correct++;else if(cls.status==='near')near++;else if(cls.status==='missing')missing++;else wrong++;words.push({text:p.ref,status:cls.status,sim:Math.round(cls.sim*100)/100,heard:p.hyp});}
    const total=refWords.length||1;const pronunciation=Math.round((correct*1+near*0.6+wrong*0.15)/total*100);
    let fluency=Math.round((hypWords.length?Math.min(1,(correct+near)/total):0)*100);
    if(opts.spokenMs&&opts.refMs){const ratio=opts.spokenMs/opts.refMs;const pace=Math.max(0,1-Math.abs(Math.log(ratio||1))/Math.log(2.2));fluency=Math.round(fluency*0.6+pace*40);}
    fluency=Math.max(0,Math.min(100,fluency-extra*4));
    let intonation=null;if(opts.pitch&&opts.pitch.length){const v=opts.pitch.filter(f=>f>50&&f<500);if(v.length>3){const s=v.map(f=>12*Math.log2(f/100));const mean=s.reduce((a,b)=>a+b,0)/s.length;const std=Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/s.length);intonation=Math.round(Math.max(0,Math.min(100,(std/4)*100)));}}
    const overall=Math.round(pronunciation*0.6+fluency*0.25+(intonation==null?pronunciation:intonation)*0.15);
    return{words,pronunciation,fluency,intonation,overall,counts:{correct,near,wrong,missing,extra,total},transcript:hypText};}
  const API={sanitize,koelner,levenshtein,phoneticSim,genericSim,setLang,alignWords,classify,analyze};
  if(typeof module!=='undefined'&&module.exports)module.exports=API;
  if(root){root.SD=root.SD||{};root.SD.phonetic=API;}
})(typeof window!=='undefined'?window:null);
