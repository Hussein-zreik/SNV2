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
     locked         { 'YYYY-MM-DD'(cycle Monday): { id: [14 shifts] } } (optional)
                    a LOCKED fortnight: returned exactly as saved — no rules,
                    requests or roster changes reach it
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
  // Nights (N7) are never moved, and no day shift is moved onto the morning
  // after a night — so rows with nights are repaired around them.
  const afterN=(row,d)=>d>0&&row[d-1]==='N7';
  function repairRuns(sh,nightSet,locks){
    for(let i=0;i<sh.length;i++){
      for(let guard=0;guard<40&&maxRunLen(sh[i])>3;guard++){
        let moved=false;
        for(let d=0;d<14&&!moved;d++){
          if(!WORK.has(sh[i][d]))continue;
          if(locks&&locks[i][d]!==null)continue; // never move a requested (locked) shift
          if(sh[i][d]==='N7')continue;          // nights stay put
          let st=d;while(st>0&&WORK.has(sh[i][st-1]))st--;
          let en=d;while(en<13&&WORK.has(sh[i][en+1]))en++;
          if(en-st+1<=3)continue;            // this day is not in an over-long run
          const wd=d%7,type=sh[i][d];
          if(wd>=5)continue;                 // only relocate weekday shifts
          if(dtc(sh,d,type)<=((DMIN[wd][type])||0))continue; // no surplus -> can't drop
          const wkStart=Math.floor(d/7)*7,before=en-st+1;
          for(let dd=wkStart;dd<wkStart+5;dd++){
            if(sh[i][dd]!=='OFF'||(locks&&locks[i][dd]!==null)||afterN(sh[i],dd))continue; // free, non-locked slot
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
    const nn=[];for(let i=0;i<sh.length;i++)nn.push(i);
    for(const i of nn){
      for(let guard=0;guard<40&&maxRunLen(sh[i])>3;guard++){
        let done=false;
        for(let d=0;d<14&&!done;d++){
          if(!WORK.has(sh[i][d])||(d%7)>=5||sh[i][d]==='N7')continue;
          if(locks&&locks[i][d]!==null)continue;   // don't move nurse i's locked shift
          let st=d;while(st>0&&WORK.has(sh[i][st-1]))st--;
          let en=d;while(en<13&&WORK.has(sh[i][en+1]))en++;
          if(en-st+1<=3)continue;
          const wk=Math.floor(d/7)*7,Ti=sh[i][d],before=maxRunLen(sh[i]);
          for(const j of nn){
            if(j===i||sh[j][d]!=='OFF'||(locks&&locks[j][d]!==null)||afterN(sh[j],d))continue;   // j free (non-locked) on d
            for(let dj=wk;dj<wk+5;dj++){
              if(dj===d||(dj%7)>=5)continue;
              if(!WORK.has(sh[j][dj])||sh[j][dj]==='N7'||sh[i][dj]!=='OFF'||afterN(sh[i],dj))continue; // i free on dj
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
    return {nightA,nightB,seqA,seqB,size,
      wkndA:pickAvoiding(a,off*2+2,nset,2),
      wkndB:pickAvoiding(b,off*2+2,nset,2)};
  }

  /* ---------- schedule generation ----------
     Rule priority, highest first — a lower rule gives way to a higher one:
       1. every RN works exactly their weekly split — Group A 4 then 3, Group B
          3 then 4 — and the manager's entries (duties, and Hol/Vac/SL, which
          replace a duty) count toward it, so only the difference is added;
       2. weekday staffing minimums per shift type;
       3. nights staffed by the N7 minimum — a night-turn nurse gets nights only
          up to their weekly count, and a night lost that way is backfilled
          from the night list when another RN is free;
       4. everything else (<=3 days in a row, no weekend surplus) — only where
          it does not cost a duty.
     The manager's entries (locks) are never moved or overwritten, so a week the
     manager over-fills by hand is left as entered (the banner reports it). */
  const LEAVE=new Set(['VAC','HOL','SL']);
  const NA_DAYS=[0,1,5,6,9,10,11],NB_DAYS=[2,3,4,7,8,12,13];
  const splitOf=g=>g==='A'?[4,3]:[3,4];
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
    // ----- LOCKED fortnight: view-only, exactly as it was when locked -----
    if(ctx.locked&&ctx.locked[gk]){
      const L=ctx.locked[gk];
      for(let i=0;i<N;i++){const row=L[ids[i]];for(let d=0;d<14;d++)sh[i][d]=row?row[d]:'OFF';}
      return {days:days14,sh,weekStart:base};
    }
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

    const TURN=turnFor(ctx,off),size=TURN.size;
    const isEntry=s=>WORK.has(s)||LEAVE.has(s);
    // rule 1: the week's duty target — the split, less any Hol/Vac/SL entered
    const target=(i,w)=>{let q=splitOf(groups[i])[w];for(let d=w*7;d<w*7+7;d++)if(LEAVE.has(locks[i][d]))q--;return Math.max(0,q);};
    // entries already in week w of a row (duties + leave) that count toward the split
    const usedIn=(i,w)=>{let c=0;for(let d=w*7;d<w*7+7;d++)if(isEntry(sh[i][d]))c++;return c;};
    const nightsOn=d=>{let c=0;for(let i=0;i<N;i++)if(sh[i][d]==='N7')c++;return c;};

    // ----- NIGHTS -----
    // The night turn: `size` from group A on the NA pattern (4-duty week
    // Mon/Tue/Sat/Sun, 3-duty week Wed/Thu/Fri) and `size` from group B on the NB
    // pattern. A turn nurse gets nights only up to the week's split, counting
    // their own entries — so a day duty the manager enters costs them a night
    // rather than pushing them to 8. Any N7 entered by hand is a lock.
    const nightSet=new Set();
    for(let i=0;i<N;i++)for(let d=0;d<14;d++)if(locks[i][d]==='N7'){nightSet.add(i);break;}
    // which night goes first: the one the evening before a locked day duty (a
    // night->day turnaround), then those nearest a locked duty
    const nearDuty=(i,d)=>{let s=99;for(let x=0;x<14;x++){const L=locks[i][x];
      if(L===null||L==='N7'||!WORK.has(L))continue;const v=x-d===1?0:Math.abs(x-d);if(v<s)s=v;}return s;};
    function placeTurn(team,pat){
      for(const i of team){
        nightSet.add(i);
        for(const w of [0,1]){
          const free=pat.filter(d=>Math.floor(d/7)===w&&locks[i][d]===null);
          const room=Math.max(0,splitOf(groups[i])[w]-usedIn(i,w));
          const keep=free.slice().sort((x,y)=>nearDuty(i,y)-nearDuty(i,x)||x-y).slice(0,room);
          for(const d of keep)sh[i][d]='N7';
        }
      }
    }
    placeTurn(TURN.nightA,NA_DAYS);placeTurn(TURN.nightB,NB_DAYS);
    // A night the manager already staffed by hand (another RN's N7 entry) does
    // not need the turn nurse: their night is handed back and they are given day
    // duties to reach the split instead.
    const turnAll=[...TURN.nightA,...TURN.nightB];
    for(let d=0;d<14;d++){
      let c=nightsOn(d);
      for(let k=turnAll.length-1;k>=0&&c>size;k--){const i=turnAll[k];
        if(sh[i][d]==='N7'&&locks[i][d]===null){sh[i][d]='OFF';c--;}}
    }
    // Backfill a night the turn left short, from the same group's night list:
    // an RN off the turn and off the weekend turn, free that night, with room in
    // that week's split, and no locked day duty the next morning. Someone already
    // on an adjacent night is preferred (one block, not scattered nights), then
    // whoever is next in the rotation.
    const wkndSet=new Set([...TURN.wkndA,...TURN.wkndB]);
    function backfill(team,pat,seq){
      if(!team.length||!seq.length)return;
      const after=Math.max(...team.map(i=>seq.indexOf(i)))+1;
      const rot=j=>((seq.indexOf(j)-after)%seq.length+seq.length)%seq.length;
      for(const d of pat){
        const w=Math.floor(d/7);
        for(let c=nightsOn(d);c<size;c++){
          const cand=seq.filter(j=>!team.includes(j)&&!wkndSet.has(j)&&sh[j][d]==='OFF'&&locks[j][d]===null
            &&usedIn(j,w)<splitOf(groups[j])[w]
            &&!(d<13&&locks[j][d+1]!==null&&locks[j][d+1]!=='N7'&&WORK.has(locks[j][d+1])));
          if(!cand.length)break;
          const adj=j=>(d>0&&sh[j][d-1]==='N7')||(d<13&&sh[j][d+1]==='N7')?1:0;
          cand.sort((x,y)=>adj(y)-adj(x)||rot(x)-rot(y));
          sh[cand[0]][d]='N7';nightSet.add(cand[0]);
        }
      }
    }
    backfill(TURN.nightA,NA_DAYS,TURN.seqA);backfill(TURN.nightB,NB_DAYS,TURN.seqB);

    // ----- Rest across the cycle boundary (post-night / post-weekend) -----
    const postNight=new Set();   // RNs whose previous fortnight ended on a Sunday night
    if(applyBoundary){
      const prev=computeSchedule(ctx,off-1,false,true).sh;   // no recursion, and always filled
      for(let i=0;i<N;i++){
        if(i<prev.length&&prev[i][13]==='N7')postNight.add(i);
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
      // rule 1 applies to EVERY RN — night nurses included, so one whose nights
      // were cut by an entry or handed back is topped up with day duties
      const quota=Array(N).fill(0),assigned=Array(N).fill(0);
      for(let i=0;i<N;i++){
        quota[i]=target(i,week);
        let c=0;for(let d=0;d<7;d++)if(WORK.has(sh[i][base7+d]))c++;
        assigned[i]=c;
      }
      // never a day duty the morning after a night
      const afterNight=(i,gd)=>gd===0?postNight.has(i):sh[i][gd-1]==='N7';
      const freeSlot=(i,gd)=>sh[i][gd]==='OFF'&&locks[i][gd]===null&&!afterNight(i,gd);

      function eligible(i,gd,guardStreak){
        if(!freeSlot(i,gd))return false;
        if(assigned[i]>=quota[i])return false;   // the split is never exceeded
        if(guardStreak&&streak(sh,i,gd)>=3)return false;
        return true;
      }
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
      const weekendGd=[base7+5,base7+6];
      for(let i=0;i<N;i++){
        const rem=quota[i]-assigned[i];
        if(rem<=0)continue;
        const freeWk=weekdayGd.filter(gd=>freeSlot(i,gd));
        const subset=pickWeekdaySubset(sh[i],freeWk,rem,rng);
        if(subset){
          for(const gd of subset){sh[i][gd]=shuffleArr(CORE,rng)[0];assigned[i]++;}
          continue;
        }
        // No way to ADD the remaining shifts without exceeding 3 in a row (common
        // when a request pins a duty or a day off). The count wins (rule 1), so
        // place them anyway, in order of preference: a weekday that keeps <=3 in
        // a row, any weekday, a weekday held back as rest after a weekend, and
        // last a weekend day. The repair pass below then tries to re-arrange the
        // week to bring any long run back to 3 without losing a duty.
        const restSlot=gd=>sh[i][gd]==='RST'&&locks[i][gd]===null&&!afterNight(i,gd);
        let safety=0;
        while(assigned[i]<quota[i]&&safety++<50){
          const tiers=[
            weekdayGd.filter(gd=>freeSlot(i,gd)&&streak(sh,i,gd)<3),
            weekdayGd.filter(gd=>freeSlot(i,gd)),
            weekdayGd.filter(restSlot),
            weekendGd.filter(gd=>freeSlot(i,gd)||restSlot(gd))];
          const t=tiers.findIndex(x=>x.length);
          if(t<0)break;   // every slot is an entry or follows a night: left under, reported
          const gd=shuffleArr(tiers[t],rng)[0];
          sh[i][gd]=t===3?'D7':shuffleArr(CORE,rng)[0];
          assigned[i]++;
        }
      }
    }
    // ----- Keep runs to <=3 where possible -----
    const baseSnap=sh.map(r=>r.slice());
    let best=null,bestMax=99;
    for(let att=0;att<30;att++){
      const work=baseSnap.map(r=>r.slice());
      const arng=mkRng((eSeed^(off*0x9e3779)^(att*0x85ebca6b))>>>0);
      assignWeek(0,work,arng);assignWeek(1,work,arng);
      repairRuns(work,nightSet,locks);swapRepair(work,nightSet,locks);repairRuns(work,nightSet,locks);
      // score = total days beyond 3-in-a-row across all rows, so one forced long
      // run (from an entry) does not stop the search improving everyone else's
      let mx=0;for(let i=0;i<N;i++){const r=maxRunLen(work[i]);if(r>3)mx+=r-3;}
      if(mx<bestMax){bestMax=mx;best=work;}
      if(mx===0)break;
    }
    // A run over 3 that no re-arrangement could break (e.g. a Monday day-off
    // request leaving only Tue-Fri for a 4-duty week) is KEPT: the duty count
    // outranks the run rule, and the banner reports the 4+ days in a row.
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

  /* ---------- rebalance ONE nurse after an edit on a generated fortnight ----------
     Auto mode only. A generated fortnight is a baked grid, so an edit there would
     otherwise leave that nurse at 8 (or 6). This brings row `i` of `sh` back to its
     weekly split by removing or adding app-made duties in the same week; the
     manager's entries (ctx.overrides) are never touched and no other row changes.
     A night that has to go is simply dropped — it is not backfilled — so it shows
     as a short night for the manager to fix. Mutates sh[i]; returns the changed
     day indexes. */
  function rebalanceRow(ctx,off,i,sh){
    WORK=ctx.work; DMIN=ctx.dailyMin; CORE=ctx.coreDay;
    const base=addDays(ctx.anchorMonday,off*14),id=ctx.ids[i],row=sh[i],changed=[];
    const lock=d=>{const o=ctx.overrides[isoKey(addDays(base,d))];return o&&o[id]!==undefined?o[id]:null;};
    const short=(d,t)=>((DMIN[d%7]||{})[t]||0)-dtc(sh,d,t);   // >0: below the minimum
    for(const w of [0,1]){
      const lo=w*7;
      let tgt=splitOf(ctx.groups[i])[w];
      for(let d=lo;d<lo+7;d++)if(LEAVE.has(lock(d)))tgt--;
      tgt=Math.max(0,tgt);
      let count=0;for(let d=lo;d<lo+7;d++)if(WORK.has(row[d]))count++;
      // too many: drop an app-made duty. A night goes first if there is one (the
      // one the evening before a locked day duty, else the nearest to it); else
      // the day duty whose loss hurts staffing least and shortens a run most.
      while(count>tgt){
        const cand=[];for(let d=lo;d<lo+7;d++)if(WORK.has(row[d])&&lock(d)===null)cand.push(d);
        if(!cand.length)break;   // every duty is an entry: left over, reported
        const nights=cand.filter(d=>row[d]==='N7');
        let pick;
        if(nights.length){
          const near=d=>{let s=99;for(let x=0;x<14;x++){const L=lock(x);if(L===null||L==='N7'||!WORK.has(L))continue;
            const v=x-d===1?0:Math.abs(x-d);if(v<s)s=v;}return s;};
          pick=nights.sort((x,y)=>near(x)-near(y)||y-x)[0];
        }else{
          const cost=d=>{const t=row[d];row[d]='OFF';const r=maxRunLen(row);row[d]=t;return [short(d,t)>=0?1:0,r];};
          pick=cand.sort((x,y)=>{const a=cost(x),b=cost(y);return a[0]-b[0]||a[1]-b[1]||y-x;})[0];
        }
        row[pick]='OFF';count--;changed.push(pick);
      }
      // too few: add a day duty on a free, non-entry day — never the morning
      // after a night. A weekday below a minimum first (in the short type), then
      // the weekday that keeps the run shortest; a weekend day only as a last resort.
      while(count<tgt){
        const free=[];for(let d=lo;d<lo+7;d++)if(row[d]==='OFF'&&lock(d)===null&&!(d>0&&row[d-1]==='N7'))free.push(d);
        if(!free.length)break;
        const typeFor=d=>{let bt=null,bs=0;for(const t in (DMIN[d%7]||{})){if(t==='N7')continue;const s=short(d,t);if(s>bs){bs=s;bt=t;}}return bt;};
        const score=d=>{row[d]='D6';const r=maxRunLen(row);row[d]='OFF';return [d%7>=5?1:0,typeFor(d)?0:1,r];};
        const pick=free.sort((x,y)=>{const a=score(x),b=score(y);return a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||x-y;})[0];
        row[pick]=typeFor(pick)||(pick%7>=5?'D7':CORE[0]);count++;changed.push(pick);
      }
    }
    return changed;
  }

  /* ---------- partial Generate (Manual mode: Settings → Generate) ----------
     Every cell belongs to one PART: 'nights' (N7), 'weekends' (a Sat/Sun day
     shift) or 'weekdays' (a Mon-Fri day/evening shift).

     The fortnight is PLANNED ONCE, in full — every count, turn, night and backfill
     worked out exactly as a normal Generate would — and only the ticked parts are
     shown. The rest of the plan is kept (index.html stores it) and later passes
     REVEAL more of that same plan. Re-planning per pass is not equivalent: each
     pass would pick different RNs (e.g. for a backfilled night) than the slots the
     earlier pass reserved, leaving some nurses over and others under their split.

     planFortnight(ctx,off,keep)  the full plan; `keep` ({ id: [14] }) cells that are
                                  not OFF are treated as entries and planned around
     pickParts(ctx,off,plan,fill,keep)
                                  the plan's cells in the `fill` parts, plus `keep`
                                  and requests; everything else OFF
     revealParts(ctx,off,plan,grid,add)
                                  adds the plan's cells in the `add` parts to empty,
                                  non-request cells of `grid` — never taking a nurse
                                  over their week's split (a hand edit made between
                                  passes wins; the banner shows what is left short)
     Rows are by RN index. */
  const partOf=(s,d)=>s==='N7'?'nights':(d%7>=5?'weekends':'weekdays');
  const reqOf=(ctx,off)=>{const base=addDays(ctx.anchorMonday,off*14),K=Array.from({length:14},(_,d)=>isoKey(addDays(base,d)));
    return (i,d)=>{const o=ctx.overrides[K[d]];return o&&o[ctx.ids[i]]!==undefined?o[ctx.ids[i]]:null;};};
  const keptOf=(ctx,keep)=>(i,d)=>{const r=keep&&keep[ctx.ids[i]];return r&&r[d]&&r[d]!=='OFF'?r[d]:null;};
  function planFortnight(ctx,off,keep){
    const base=addDays(ctx.anchorMonday,off*14),ov={},kept=keptOf(ctx,keep);
    for(const k in ctx.overrides)ov[k]={...ctx.overrides[k]};
    for(let i=0;i<ctx.N;i++)for(let d=0;d<14;d++){
      const s=kept(i,d);if(s===null)continue;
      const k=isoKey(addDays(base,d));
      if(!ov[k])ov[k]={};
      if(ov[k][ctx.ids[i]]===undefined)ov[k][ctx.ids[i]]=s;
    }
    return computeSchedule({...ctx,overrides:ov,frozen:{},manualMode:false},off,true,true).sh;
  }
  function pickParts(ctx,off,plan,fill,keep){
    const kept=keptOf(ctx,keep),req=reqOf(ctx,off);
    return plan.map((row,i)=>row.map((s,d)=>{
      const k=kept(i,d);if(k!==null)return k;
      const r=req(i,d);if(r!==null)return r;
      return s!=='OFF'&&fill[partOf(s,d)]?s:'OFF';
    }));
  }
  function revealParts(ctx,off,plan,grid,add){
    WORK=ctx.work;
    const req=reqOf(ctx,off),out=grid.map(r=>r.slice());
    const isEntry=s=>WORK.has(s)||LEAVE.has(s);
    for(let i=0;i<out.length;i++){
      const split=splitOf(ctx.groups[i]);
      for(const w of [0,1]){
        let n=0;for(let d=w*7;d<w*7+7;d++)if(isEntry(out[i][d]))n++;
        for(let d=w*7;d<w*7+7&&n<split[w];d++){
          const s=plan[i]&&plan[i][d];
          if(!s||s==='OFF'||out[i][d]!=='OFF'||req(i,d)!==null||!add[partOf(s,d)])continue;
          out[i][d]=s;n++;
        }
      }
    }
    return out;
  }
  // one-shot: plan and show only `fill` (what a first Generate does)
  function generateParts(ctx,off,fill,keep){return pickParts(ctx,off,planFortnight(ctx,off,keep),fill,keep);}

  const Engine={getMonday,addDays,isoKey,mkRng,shuffleArr,maxRunLen,streak,dtc,
    groupSeq,pairAt,turnFor,repairRuns,swapRepair,pickWeekdaySubset,computeSchedule,rebalanceRow,
    partOf,planFortnight,pickParts,revealParts,generateParts};

  if(typeof module!=='undefined'&&module.exports)module.exports=Engine;   // Node
  if(root){                                                               // browser
    root.Engine=Engine;
    // pure helpers index.html calls directly, kept as bare globals so those call
    // sites don't change (computeSchedule/turnFor get ctx-building wrappers there)
    for(const k of ['getMonday','addDays','isoKey','mkRng','shuffleArr','maxRunLen'])root[k]=Engine[k];
  }
})(typeof window!=='undefined'?window:null);
