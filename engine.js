/* ==========================================================================
   Scheduling engine — the pure brain of the RN rotating scheduler.

   Deliberately DOM-free and global-free: every function takes what it needs as
   an argument, so it can be unit-tested in Node in milliseconds (see
   test/engine.test.mjs) instead of only through a headless browser. index.html
   loads this file and wraps computeSchedule/turnFor with thin adapters that
   build the ctx from the app's live state, so nothing at the call sites changed.

   Dual-mode: in the browser it attaches to window (and exposes the pure date/rng
   helpers as bare globals index.html already calls); in Node it is a CommonJS
   module (`import Engine from '../engine.js'`).

   ctx passed to computeSchedule / turnFor:
     N              number of RNs
     groups         ['A'|'B', ...] per RN
     order          display-order permutation of RN indices
     ids            stable id per RN (index -> id)
     overrides      { 'YYYY-MM-DD': { id: shift } } requested/locked cells
     frozen         { 'YYYY-MM-DD'(cycle Monday): { id: [14 shifts] } }
     committedCycles{ gk: true } which fortnights were generated (manual nights)
     cycleSeeds     { gk: seed } per-fortnight seed
     manualMode     bool
     seed           global fallback seed
     dailyMin       7 x {type:count} weekday/weekend minimums
     coreDay        ['D6','D7','S8','S9','S10'] fill pool
     work           Set of working shift types (day/eve + N7)
     anchorMonday   Date — the cycle-0 Monday the roster is anchored to
   ========================================================================== */
(function (root) {
  'use strict';

  // config bound per top-level computeSchedule() call, so the row helpers below
  // keep their original single-purpose signatures instead of threading it through
  let WORK = new Set(), DMIN = [], CORE = [];

  /* ---------- pure date / rng / row helpers ---------- */
  function getMonday(d){const dt=new Date(d);const dy=dt.getDay();dt.setDate(dt.getDate()+(dy===0?-6:1-dy));dt.setHours(0,0,0,0);return dt;}
  function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
  function isoKey(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${dd}`;}
  function mkRng(s){let x=s>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/0x100000000;};}
  function shuffleArr(a,rng){const r=[...a];for(let i=r.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[r[i],r[j]]=[r[j],r[i]];}return r;}

  function streak(sh,i,d){
    let b=0,a=0;
    for(let x=d-1;x>=0&&WORK.has(sh[i][x]);x--)b++;
    for(let x=d+1;x<14&&WORK.has(sh[i][x]);x++)a++;
    return b+a;
  }
  // longest consecutive run of working days in a 14-day row. `work` may be passed
  // explicitly (UI calls do); engine-internal calls use the bound WORK.
  function maxRunLen(row,work){const W=work||WORK;let m=0,r=0;for(let d=0;d<14;d++){if(W.has(row[d])){r++;if(r>m)m=r;}else r=0;}return m;}
  // count nurses working a given shift type on an absolute day
  function dtc(sh,d,type){let c=0;for(let i=0;i<sh.length;i++)if(sh[i][d]===type)c++;return c;}

  // repair >3 consecutive runs by relocating a nurse's surplus shift (one whose
  // type is above the day minimum, so it can be dropped safely) to a free weekday
  // slot in the same week that shortens the run. Preserves the 7-count, the
  // per-week split, daily minimums, and the weekday-only surplus rule.
  function repairRuns(sh,nightSet,locks){
    for(let i=0;i<sh.length;i++){
      if(nightSet.has(i))continue;
      for(let guard=0;guard<40&&maxRunLen(sh[i])>3;guard++){
        let moved=false;
        for(let d=0;d<14&&!moved;d++){
          if(!WORK.has(sh[i][d]))continue;
          if(locks&&locks[i][d]!==null)continue; // never move a requested (locked) shift
          let st=d;while(st>0&&WORK.has(sh[i][st-1]))st--;
          let en=d;while(en<13&&WORK.has(sh[i][en+1]))en++;
          if(en-st+1<=3)continue;            // this day is not in an over-long run
          const wd=d%7,type=sh[i][d];
          if(wd>=5)continue;                 // only relocate weekday shifts
          if(dtc(sh,d,type)<=((DMIN[wd][type])||0))continue; // no surplus -> can't drop
          const wkStart=Math.floor(d/7)*7,before=en-st+1;
          for(let dd=wkStart;dd<wkStart+5;dd++){
            if(sh[i][dd]!=='OFF'||(locks&&locks[i][dd]!==null))continue; // free, non-locked slot
            sh[i][d]='OFF';sh[i][dd]=type;    // trial move (same week -> split preserved)
            if(maxRunLen(sh[i])<before){moved=true;break;}
            sh[i][dd]='OFF';sh[i][d]=type;    // revert
          }
        }
        if(!moved)break; // cannot improve without breaking a minimum (very rare)
      }
    }
  }
  // resolve remaining >3 runs where every shift in the run is essential (at the
  // day minimum) via a type-preserving 2-opt: two non-night nurses swap a
  // weekday+type within the same week. Every daily minimum, both 7-counts and
  // the per-week split are preserved exactly; only the run is broken.
  function swapRepair(sh,nightSet,locks){
    const nn=[];for(let i=0;i<sh.length;i++)if(!nightSet.has(i))nn.push(i);
    for(const i of nn){
      for(let guard=0;guard<40&&maxRunLen(sh[i])>3;guard++){
        let done=false;
        for(let d=0;d<14&&!done;d++){
          if(!WORK.has(sh[i][d])||(d%7)>=5)continue;
          if(locks&&locks[i][d]!==null)continue;   // don't move nurse i's locked shift
          let st=d;while(st>0&&WORK.has(sh[i][st-1]))st--;
          let en=d;while(en<13&&WORK.has(sh[i][en+1]))en++;
          if(en-st+1<=3)continue;
          const wk=Math.floor(d/7)*7,Ti=sh[i][d],before=maxRunLen(sh[i]);
          for(const j of nn){
            if(j===i||sh[j][d]!=='OFF'||(locks&&locks[j][d]!==null))continue;   // j free (non-locked) on d
            for(let dj=wk;dj<wk+5;dj++){
              if(dj===d||(dj%7)>=5)continue;
              if(!WORK.has(sh[j][dj])||sh[i][dj]!=='OFF')continue; // i free on dj
              if(locks&&(locks[j][dj]!==null||locks[i][dj]!==null))continue; // don't move j's lock; i's target free
              const Tj=sh[j][dj];
              sh[i][d]='OFF';sh[i][dj]=Tj;sh[j][dj]='OFF';sh[j][d]=Ti; // swap
              if(maxRunLen(sh[i])<before&&maxRunLen(sh[j])<=3){done=true;break;}
              sh[i][dj]='OFF';sh[i][d]=Ti;sh[j][d]='OFF';sh[j][dj]=Tj; // revert
            }
            if(done)break;
          }
        }
        if(!done)break;
      }
    }
  }
  // choose `rem` weekday slots from `freeWk` that keep <=3 consecutive working
  // days; returns a valid subset (random among valid) or null if none exists
  function pickWeekdaySubset(row,freeWk,rem,rng){
    if(rem<=0)return [];
    if(freeWk.length<rem)return null;
    const valid=[];
    const n=freeWk.length;
    for(let mask=0;mask<(1<<n);mask++){
      let bits=0;for(let k=0;k<n;k++)if(mask&(1<<k))bits++;
      if(bits!==rem)continue;
      const test=row.slice();
      for(let k=0;k<n;k++)if(mask&(1<<k))test[freeWk[k]]='D6';
      if(maxRunLen(test)<=3){const s=[];for(let k=0;k<n;k++)if(mask&(1<<k))s.push(freeWk[k]);valid.push(s);}
    }
    if(!valid.length)return null;
    return valid[Math.floor(rng()*valid.length)];
  }

  /* ---------- rotation turns (nights + weekends) ----------
     One source of truth used by both the scheduler and the info panel. */
  function groupSeq(ctx){
    const {order,N,groups}=ctx;
    const seq=[],seen=new Set();
    for(const x of order)if(Number.isInteger(x)&&x>=0&&x<N&&!seen.has(x)){seen.add(x);seq.push(x);}
    for(let i=0;i<N;i++)if(!seen.has(i))seq.push(i);
    const a=[],b=[];for(const i of seq)(groups[i]==='A'?a:b).push(i);
    return {a,b};
  }
  function pairAt(idxs,s){
    if(!idxs.length)return [];
    if(idxs.length===1)return [idxs[0]];
    const k=((s%idxs.length)+idxs.length)%idxs.length;
    return [idxs[k],idxs[(k+1)%idxs.length]];
  }
  // the night rotation as row indices, in the manager's chosen order. ctx.nightList
  // is stable ids; map them to current rows and drop any that are gone. When it is
  // absent (older state) every RN is eligible, in roster order — the old default.
  function nightSeqOf(ctx){
    const {nightList,ids,N}=ctx;
    if(!Array.isArray(nightList))return Array.from({length:N},(_,i)=>i);
    const seq=[],seen=new Set();
    for(const id of nightList){const i=ids.indexOf(id);if(i>=0&&i<N&&!seen.has(i)){seen.add(i);seq.push(i);}}
    return seq;
  }
  // The night team for one group in a given cycle. The list is split into
  // consecutive TURNS of `size` (1-2, 3-4, 5-6, ... for size 2) and cycle `off`
  // takes turn (off mod turns) — so turns tile the list cleanly and then reroll
  // from the top, instead of drifting by one on every wrap. If the final turn is
  // short (odd list), it wraps to the front so the team is always `size` strong.
  function nightTeam(seq,off,size){
    const n=seq.length;if(!n||size<=0)return [];
    const take=Math.min(size,n),turns=Math.ceil(n/take);
    const t=((off%turns)+turns)%turns,out=[];
    for(let k=0;k<take;k++)out.push(seq[(t*take+k)%n]);
    return out;
  }
  // walk `idxs` from position s and collect `count` distinct entries not in `avoid`
  function pickAvoiding(idxs,s,avoid,count){
    const res=[],n=idxs.length;if(!n)return res;
    const start=((s%n)+n)%n;
    for(let t=0;t<n&&res.length<count;t++){const i=idxs[(start+t)%n];if(!avoid.has(i))res.push(i);}
    return res;
  }
  // whose turn it is in a given cycle — pure, so the info panel can show the
  // expected turn even when the schedule on screen has been edited by hand.
  //
  // Two rotations:
  //  - DEFAULT (ctx.nightList absent): the original group-based turn — 2 from
  //    group A + 2 from group B, weekend nights on the 3-duty group. Unchanged,
  //    so untouched rosters behave exactly as before.
  //  - CUSTOM (ctx.nightList is an array): same 2-from-A + 2-from-B structure,
  //    but each group's night pair is drawn ONLY from the RNs in the night list,
  //    in their listed order. Remove an RN and they drop out of their group's
  //    night rotation; a group with fewer than 2 eligible simply comes up short.
  function turnFor(ctx,off){
    const {a,b}=groupSeq(ctx);
    const size=Number.isInteger(ctx.nightMin)&&ctx.nightMin>0?ctx.nightMin:2;
    // eligible night RNs per group, in the night-list order (or the whole group)
    let seqA,seqB;
    if(Array.isArray(ctx.nightList)){
      const g=ctx.groups,seq=nightSeqOf(ctx);
      seqA=seq.filter(i=>g[i]==='A');seqB=seq.filter(i=>g[i]==='B');
    }else{seqA=a;seqB=b;}
    const nightA=nightTeam(seqA,off,size),nightB=nightTeam(seqB,off,size);
    // weekend day team from the full group, never a nurse already on nights
    const nset=new Set([...nightA,...nightB]);
    return {nightA,nightB,
      wkndA:pickAvoiding(a,off*2+2,nset,2),
      wkndB:pickAvoiding(b,off*2+2,nset,2)};
  }

  /* ---------- schedule generation (hardened) ----------
     Guarantees: every non-night nurse works exactly `quota` day/eve shifts,
     and every day meets dailyMin whenever the roster has the capacity. */
  function computeSchedule(ctx,off,applyBoundary=true,forceFill=false){
    WORK=ctx.work; DMIN=ctx.dailyMin; CORE=ctx.coreDay;   // bind config for the helpers
    const {N,groups,order,ids,overrides,frozen,committedCycles,cycleSeeds,manualMode,seed,anchorMonday}=ctx;
    const idxOfId=id=>ids.indexOf(id);
    const base=addDays(anchorMonday,off*14);
    const days14=Array.from({length:14},(_,i)=>addDays(base,i));
    const sh=Array.from({length:N},()=>Array(14).fill('OFF'));

    // ----- Requested duties / offs / vacations (LOCKS) -----
    const locks=Array.from({length:N},()=>Array(14).fill(null));
    for(let d=0;d<14;d++){
      const o=overrides[isoKey(days14[d])];
      if(o)for(const key in o){const idx=idxOfId(key);if(idx>=0){locks[idx][d]=o[key];sh[idx][d]=o[key];}}
    }

    const gk=isoKey(base);
    // ----- FROZEN (hand-generated) fortnight -----
    if(frozen[gk]){
      for(let i=0;i<N;i++){const row=frozen[gk][ids[i]];if(row)for(let d=0;d<14;d++)sh[i][d]=row[d];}
      for(let d=0;d<14;d++){const o=overrides[isoKey(days14[d])];if(o)for(const key in o){const idx=idxOfId(key);if(idx>=0)sh[idx][d]=o[key];}}
      return {days:days14,sh,weekStart:base};
    }
    // Manual mode: an un-generated fortnight stays EMPTY except your entries.
    if(manualMode&&!forceFill&&!committedCycles[gk])return {days:days14,sh,weekStart:base};
    // Once a fortnight has been generated its own seed is used from then on in both modes.
    const eSeed=(cycleSeeds[gk]!==undefined)?cycleSeeds[gk]:seed;

    const TURN=turnFor(ctx,off);
    // ----- NIGHTS -----
    // The night turn is placed automatically in BOTH modes: 2 from group A on the
    // NA pattern (4-duty week Mon/Tue/Sat/Sun, 3-duty week Wed/Thu/Fri) and 2 from
    // group B on the NB pattern — so every night is covered and each night nurse
    // works exactly 7 nights. Any N7 the manager enters by hand is a lock: it is
    // kept, and that nurse is also treated as a night nurse (kept off day quota).
    const nightA=TURN.nightA,nightB=TURN.nightB;
    const NA_DAYS=[0,1,5,6,9,10,11],NB_DAYS=[2,3,4,7,8,12,13];
    const nightSet=new Set([...nightA,...nightB]);
    for(let i=0;i<N;i++)for(let d=0;d<14;d++)if(locks[i][d]==='N7'){nightSet.add(i);break;}
    for(const i of nightA)for(const d of NA_DAYS)if(locks[i][d]===null)sh[i][d]='N7';
    for(const i of nightB)for(const d of NB_DAYS)if(locks[i][d]===null)sh[i][d]='N7';

    // ----- Rest across the cycle boundary (post-night / post-weekend) -----
    if(applyBoundary){
      const prev=computeSchedule(ctx,off-1,false,true).sh;   // no recursion, and always filled
      for(let i=0;i<N;i++){
        if(nightSet.has(i)||i>=prev.length)continue;
        const p=prev[i];
        if(!(WORK.has(p[12])&&WORK.has(p[13])))continue;   // worked Sat+Sun last cycle
        if(p[13]==='N7'){ if(sh[i][0]==='OFF'&&locks[i][0]===null)sh[i][0]='RST'; }  // post-night -> Monday rest
        else if(sh[i][1]==='OFF'&&locks[i][1]===null)sh[i][1]='RST';                 // post-weekend day -> Tuesday rest
      }
    }

    // ----- Weekend DAY duty: a FIXED TURN that follows the night turn -----
    function placeWeekendDuty(){
      const plan=[{w:0,pair:TURN.wkndA},{w:1,pair:TURN.wkndB}];
      for(const{w,pair}of plan){
        const satD=w*7+5,sunD=w*7+6;
        for(const i of pair){
          if(nightSet.has(i))continue;                  // safety: tiny groups
          if(locks[i][satD]===null&&sh[i][satD]==='OFF')sh[i][satD]='D7';
          if(locks[i][sunD]===null&&sh[i][sunD]==='OFF')sh[i][sunD]='D7';
        }
      }
      // Closing weekend: anyone working BOTH Sat(12)+Sun(13) stays off the
      // preceding Friday so their run into the next cycle stays within 3.
      for(let i=0;i<N;i++){
        if(!nightSet.has(i)&&WORK.has(sh[i][12])&&WORK.has(sh[i][13])&&sh[i][11]==='OFF'&&locks[i][11]===null)sh[i][11]='RST';
      }
    }
    placeWeekendDuty();

    function assignWeek(week,sh,rng){
      const base7=week*7;
      const quota=Array(N).fill(0);
      for(let i=0;i<N;i++){
        if(nightSet.has(i)){quota[i]=0;continue;}
        const isA=groups[i]==='A';let q=(isA?(week===0?4:3):(week===0?3:4));
        // A VAC/HOL/SL entry replaces a working shift, so it uses up one of the
        // week's duties rather than sitting on top of them.
        for(let d=base7;d<base7+7;d++){const L=locks[i][d];if(L==='VAC'||L==='HOL'||L==='SL')q--;}
        quota[i]=Math.max(0,q);
      }
      const assigned=Array(N).fill(0);
      for(let i=0;i<N;i++){
        if(nightSet.has(i))continue;
        let c=0;for(let d=0;d<7;d++)if(WORK.has(sh[i][base7+d]))c++;
        assigned[i]=c;
      }
      const freeSlot=(i,gd)=>sh[i][gd]==='OFF'&&locks[i][gd]===null;

      function eligible(i,gd,guardStreak,overQuota){
        if(nightSet.has(i))return false;
        if(!freeSlot(i,gd))return false;
        if(!overQuota&&assigned[i]>=quota[i])return false;
        if(guardStreak&&streak(sh,i,gd)>=3)return false;
        return true;
      }
      // The per-nurse turn quota (4/3-3/4) is absolute: never exceeded.
      function place(i,gd,type){sh[i][gd]=type;assigned[i]++;}

      // 1) satisfy WEEKDAY minimums (Mon-Fri); weekend day coverage is fixed above
      const mandatory=[];
      for(let d=0;d<5;d++){
        const need=DMIN[d];
        // N7 is the NIGHT minimum — staffed by the night team, never by the day fill
        for(const[type,cnt]of Object.entries(need)){if(type==='N7')continue;
          for(let c=0;c<cnt;c++)mandatory.push({gd:base7+d,type});}
      }
      const idxAll=Array.from({length:N},(_,i)=>i);
      for(const slot of shuffleArr(mandatory,rng)){
        let pool=shuffleArr(idxAll.filter(i=>eligible(i,slot.gd,true)),rng);
        if(!pool.length)pool=shuffleArr(idxAll.filter(i=>eligible(i,slot.gd,false)),rng);
        if(!pool.length)continue; // nobody free within quota -> left short for manual fix
        pool.sort((a,b)=>(quota[b]-assigned[b])-(quota[a]-assigned[a]));
        place(pool[0],slot.gd,slot.type);
      }

      // 2) fill every remaining quota shift so each nurse reaches exactly `quota`.
      const weekdayGd=Array.from({length:5},(_,d)=>base7+d); // Mon-Fri
      for(let i=0;i<N;i++){
        if(nightSet.has(i))continue;
        const rem=quota[i]-assigned[i];
        if(rem<=0)continue;
        const freeWk=weekdayGd.filter(gd=>freeSlot(i,gd));
        const subset=pickWeekdaySubset(sh[i],freeWk,rem,rng);
        if(subset){
          for(const gd of subset){sh[i][gd]=shuffleArr(CORE,rng)[0];assigned[i]++;}
          continue;
        }
        // No way to ADD the remaining shifts to this nurse's existing days without
        // exceeding 3 in a row (common when a request pins a midweek duty). Place
        // them greedily on WEEKDAYS anyway, allowing a temporary long run: the
        // repair pass below can RE-ARRANGE the whole week (which a per-nurse
        // add-only search cannot), and the safety trim afterwards guarantees <=3.
        let safety=0;
        while(assigned[i]<quota[i]&&safety<400){
          safety++;
          let pick=null;
          for(const[pool,guard]of [[weekdayGd,true],[weekdayGd,false]]){
            const c=shuffleArr(pool.filter(gd=>freeSlot(i,gd)&&(!guard||streak(sh,i,gd)<3)),rng);
            if(c.length){pick=c[0];break;}
          }
          if(pick===null)break;
          sh[i][pick]=shuffleArr(CORE,rng)[0];
          assigned[i]++;
        }
      }
    }
    // ----- Guarantee <=3 consecutive days -----
    const baseSnap=sh.map(r=>r.slice());
    let best=null,bestMax=99;
    for(let att=0;att<30;att++){
      const work=baseSnap.map(r=>r.slice());
      const arng=mkRng((eSeed^(off*0x9e3779)^(att*0x85ebca6b))>>>0);
      assignWeek(0,work,arng);assignWeek(1,work,arng);
      repairRuns(work,nightSet,locks);swapRepair(work,nightSet,locks);repairRuns(work,nightSet,locks);
      let mx=0;for(let i=0;i<N;i++){const r=maxRunLen(work[i]);if(r>mx)mx=r;}
      if(mx<bestMax){bestMax=mx;best=work;}
      if(mx<=3)break;
    }
    // Absolute <=3: if repair could not resolve every run (a FORCED case — e.g. a
    // nurse coming off a week of weekend nights whose 4-duty week only leaves
    // Tue-Fri, which no reshuffle can break), drop the offending non-locked
    // weekday shift(s). The <=3 rule and the no-weekend-surplus rule are absolute
    // and win; the nurse is simply left UNDER quota (short-staffed — fill with a
    // manual holiday). Never a 4th consecutive day.
    if(bestMax>3){
      for(let i=0;i<N;i++){
        if(nightSet.has(i))continue;
        let guard=0;
        while(maxRunLen(best[i])>3&&guard++<14){
          let cut=-1,cutWknd=-1;
          for(let d=0;d<14;d++){
            if(!WORK.has(best[i][d])||locks[i][d]!==null)continue;
            let st=d;while(st>0&&WORK.has(best[i][st-1]))st--;
            let en=d;while(en<13&&WORK.has(best[i][en+1]))en++;
            if(en-st+1>3){ if(d%7<5){cut=d;break;} else if(cutWknd<0)cutWknd=d; }
          }
          if(cut<0)cut=cutWknd;          // prefer trimming a weekday; weekend only if forced
          if(cut<0)break;
          best[i][cut]='OFF';
        }
      }
    }
    for(let i=0;i<N;i++)for(let d=0;d<14;d++)sh[i][d]=best[i][d];
    // clear post-night rest markers back to plain days off (display + counts)
    for(let i=0;i<N;i++)for(let d=0;d<14;d++)if(sh[i][d]==='RST')sh[i][d]='OFF';

    // 3) apply saved manual overrides keyed by absolute date
    for(let d=0;d<14;d++){
      const k=isoKey(days14[d]);
      if(overrides[k])for(const key in overrides[k]){const idx=idxOfId(key);if(idx>=0)sh[idx][d]=overrides[k][key];}
    }

    return {days:days14,sh,weekStart:base};
  }

  const Engine={getMonday,addDays,isoKey,mkRng,shuffleArr,maxRunLen,streak,dtc,
    groupSeq,pairAt,turnFor,repairRuns,swapRepair,pickWeekdaySubset,computeSchedule};

  if(typeof module!=='undefined'&&module.exports)module.exports=Engine;   // Node
  if(root){                                                               // browser
    root.Engine=Engine;
    // pure helpers index.html calls directly, kept as bare globals so those call
    // sites don't change (computeSchedule/turnFor get ctx-building wrappers there)
    for(const k of ['getMonday','addDays','isoKey','mkRng','shuffleArr','maxRunLen'])root[k]=Engine[k];
  }
})(typeof window!=='undefined'?window:null);
