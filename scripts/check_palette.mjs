// Self-contained on purpose: this ran `make palette` against an absolute path
// on one machine's disk, so it failed everywhere else. Everything it needs —
// sRGB decode, the Machado CVD matrices, Oklab — is computed here in ~10 lines.
const srgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255);
const lin=h=>srgb(h).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
const MACHADO={protan:[[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
               deutan:[[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]]};
const oklabFromLin=([r,g,b])=>{const l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b),
 m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b),s=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
 return [0.2104542553*l+0.7936177850*m-0.0040720468*s,1.9779984951*l-2.4285922050*m+0.4505937099*s,0.0259040371*l+0.7827717662*m-0.8086757660*s];};
const sim=(h,k)=>{const [r,g,b]=lin(h),M=MACHADO[k],c=x=>Math.max(0,Math.min(1,x));
 return [c(M[0][0]*r+M[0][1]*g+M[0][2]*b),c(M[1][0]*r+M[1][1]*g+M[1][2]*b),c(M[2][0]*r+M[2][1]*g+M[2][2]*b)];};
const dE=(h1,h2,k)=>{const a=oklabFromLin(k?sim(h1,k):lin(h1)),b=oklabFromLin(k?sim(h2,k):lin(h2));
 return 100*Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);};

const HUES=["#3987e5","#d95926","#199e70","#c98500","#d55181","#008300","#9085e9","#e66767"];
const NAMES=["blue","orange","aqua","yellow","magenta","green","violet","red"];
const SECTORS=["Western(PAD)","WestCoast+Chiltern(EUS/MYB)","Midland+HS1(STP)","EastCoast+GN(KGX/MOG)",
               "GreatEastern(LST/FST)","SouthEastern(CHX/CST/LBG/BFR)","Southern(VIC)","SouthWestern(WAT)"];
// sectors that physically touch / interleave on the map
// Sector pairs that run near each other for a sustained stretch, so their
// colours must be separable. The ring around London, plus the chords: HS1 puts
// St Pancras trains through Kent, the West Coast and East Coast meet across
// Hertfordshire, and the Midland and Great Eastern lines run roughly parallel
// out to Bedfordshire/Essex.
const EDGES=[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,0],[2,5],[1,3],[0,7],[5,7],[2,4]];

const pairScore=(a,b)=>Math.min(dE(a,b,"protan"),dE(a,b,"deutan"));
const norm=(a,b)=>dE(a,b);

let best=null;
const perm=[],used=Array(8).fill(false);
(function rec(){
  if(perm.length===8){
    let mc=Infinity,mn=Infinity;
    for(const [i,j] of EDGES){mc=Math.min(mc,pairScore(HUES[perm[i]],HUES[perm[j]]));mn=Math.min(mn,norm(HUES[perm[i]],HUES[perm[j]]));}
    const score=Math.min(mc,mn/1.9);
    if(!best||score>best.score) best={score,mc,mn,p:[...perm]};
    return;
  }
  for(let i=0;i<8;i++) if(!used[i]){used[i]=true;perm.push(i);rec();perm.pop();used[i]=false;}
})();

console.log(`best: worst-CVD ΔE ${best.mc.toFixed(1)}   worst-normal ΔE ${best.mn.toFixed(1)}  (over ${EDGES.length} touching pairs)\n`);
best.p.forEach((h,s)=>console.log(`  ${SECTORS[s].padEnd(32)} ${HUES[h]}  ${NAMES[h]}`));
console.log("\nweakest touching pairs:");
EDGES.map(([i,j])=>({p:`${NAMES[best.p[i]]}/${NAMES[best.p[j]]}`,s:`${SECTORS[i].split("(")[0]}↔${SECTORS[j].split("(")[0]}`,
  cvd:pairScore(HUES[best.p[i]],HUES[best.p[j]]),nor:norm(HUES[best.p[i]],HUES[best.p[j]])}))
 .sort((a,b)=>a.cvd-b.cvd).slice(0,5).forEach(x=>console.log(`  ${x.s.padEnd(34)} ${x.p.padEnd(16)} cvd ${x.cvd.toFixed(1)}  normal ${x.nor.toFixed(1)}`));
console.log("\nORDER=" + JSON.stringify(best.p.map(h=>HUES[h])));
