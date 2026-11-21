'use strict';

/* ---------- Storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('stride.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stride.' + k, JSON.stringify(v)); } catch { toast('Could not save – storage full?'); } },
  del(k) { try { localStorage.removeItem('stride.' + k); } catch {} }
};

const settings = Object.assign({ units: 'km', goal: 10, voice: true, vibrate: true, wake: true }, LS.get('settings', {}));
let runs = LS.get('runs', []);
let planDone = LS.get('planDone', {});

const saveSettings = () => LS.set('settings', settings);
const saveRuns = () => LS.set('runs', runs);
const savePlan = () => LS.set('planDone', planDone);

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);
const unitM = () => settings.units === 'mi' ? 1609.344 : 1000;
const unitShort = () => settings.units === 'mi' ? 'mi' : 'km';
const unitLong = () => settings.units === 'mi' ? 'miles' : 'kilometres';
const fmtDist = m => (m / unitM()).toFixed(2);
const pad = n => String(n).padStart(2, '0');

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtPace(secPerUnit) {
  if (!isFinite(secPerUnit) || secPerUnit <= 0 || secPerUnit > 3600) return '–';
  return `${Math.floor(secPerUnit / 60)}:${pad(Math.round(secPerUnit % 60) % 60)}`;
}
function fmtDur(sec) { // for speech/plan descriptions
  const m = Math.floor(sec / 60), s = sec % 60;
  if (!m) return `${s} seconds`;
  return s ? `${m} minutes ${s} seconds` : `${m} minute${m > 1 ? 's' : ''}`;
}
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
const FEEL = ['', '😫', '😕', '🙂', '😄', '🔥'];

// In-page confirmation (native confirm() is blocked in some embedded viewers)
function ask(msg, okText = 'Yes', cancelText = 'Cancel') {
  return new Promise(resolve => {
    const d = $('askDlg');
    $('askMsg').textContent = msg; $('askOk').textContent = okText; $('askCancel').textContent = cancelText;
    const done = v => { d.close(); $('askOk').onclick = $('askCancel').onclick = d.oncancel = null; resolve(v); };
    $('askOk').onclick = () => done(true);
    $('askCancel').onclick = () => done(false);
    d.oncancel = e => { e.preventDefault(); done(false); };
    d.showModal();
  });
}

/* ---------- Audio / voice / vibration ---------- */
let audioCtx;
function beep(freq = 880, dur = 0.15, times = 1) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const t0 = audioCtx.currentTime + i * (dur + 0.08);
      o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.25, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.start(t0); o.stop(t0 + dur);
    }
  } catch {}
}
function say(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1; speechSynthesis.speak(u); } catch {}
}
function buzz(pattern) { if (settings.vibrate && navigator.vibrate) navigator.vibrate(pattern); }

/* ---------- Wake lock ---------- */
let wakeLock = null;
async function acquireWake() {
  if (!settings.wake || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && !session.paused) acquireWake();
});

/* ---------- Navigation ---------- */
const TITLES = { run: 'Run', plan: 'Training plan', history: 'Progress', settings: 'Settings' };
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('screenTitle').textContent = TITLES[v];
  if (v === 'plan') renderPlan();
  if (v === 'history') renderHistory();
  window.scrollTo(0, 0);
}

/* ---------- Plan helpers ---------- */
const SEG_NAME = { warmup: 'Warm-up walk', run: 'Run', walk: 'Walk', cooldown: 'Cool-down walk' };
const planKey = (w, d) => `w${w}d${d}`;
function nextPlanWorkout() {
  for (const wk of PLAN) for (let d = 0; d < 3; d++) if (!planDone[planKey(wk.week, d + 1)]) return { week: wk.week, day: d + 1 };
  return null;
}
function describeWorkout(segs) {
  const core = segs.filter(s => s[0] === 'run' || s[0] === 'walk');
  const runs = core.filter(s => s[0] === 'run');
  const total = segs.reduce((a, s) => a + s[1], 0);
  const runTotal = runs.reduce((a, s) => a + s[1], 0);
  let txt;
  const allSame = runs.every(r => r[1] === runs[0][1]);
  const walks = core.filter(s => s[0] === 'walk');
  if (runs.length === 1) txt = `Run ${fmtTime(runs[0][1])} non-stop`;
  else if (allSame && walks.every(w => w[1] === (walks[0] || [0, 0])[1])) txt = `${runs.length} × run ${fmtTime(runs[0][1])}` + (walks.length ? ` / walk ${fmtTime(walks[0][1])}` : '');
  else txt = core.map(s => (s[0] === 'run' ? 'R' : 'W') + fmtTime(s[1])).join(' · ');
  return { txt, sub: `${Math.round(total / 60)} min total · ${Math.round(runTotal / 60)} min running` };
}

/* ---------- Run session ---------- */
let session = null, watchId = null, tickTimer = null;

function newSession(workout) {
  return {
    startedAt: Date.now(), accMs: 0, resumedAt: Date.now(), paused: false,
    points: [], distM: 0, last: null, splits: [], nextSplit: unitM(), lastSplitSec: 0,
    workout: workout || null, segIdx: -1, workoutDone: false
  };
}
function elapsedSec() {
  if (!session) return 0;
  return (session.accMs + (session.paused ? 0 : Date.now() - session.resumedAt)) / 1000;
}

function startRun(workout) {
  if (session) return;
  session = newSession(workout);
  beep(660, 0.12, 1); // unlocks audio on iOS (user gesture)
  startGps();
  acquireWake();
  tickTimer = setInterval(tick, 500);
  $('controlsIdle').classList.add('hidden');
  $('controlsActive').classList.remove('hidden');
  $('btnPause').textContent = 'Pause';
  $('workoutBanner').classList.toggle('hidden', !workout);
  if (!workout) say('Run started. Have a great run.');
  tick();
  showView('run');
}

function startGps() {
  if (!('geolocation' in navigator)) { setGps('GPS not available on this device: time only', 'warn'); return; }
  setGps('Searching for GPS…', 'warn');
  watchId = navigator.geolocation.watchPosition(onPos, err => {
    if (err.code === 1) { session && (session.noGps = true); setGps('No location access: timing only. You can enter the distance when you finish.', 'warn'); }
    else setGps('GPS signal lost…', 'warn');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function stopGps() { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; }
function setGps(text, cls) { const g = $('gpsStatus'); g.textContent = text; g.className = 'gps ' + (cls || ''); }

function onPos(pos) {
  if (!session) return;
  const { latitude, longitude, accuracy } = pos.coords;
  const t = Date.now();
  if (accuracy > 35) { setGps(`Weak GPS (±${Math.round(accuracy)} m)`, 'warn'); return; }
  setGps(`GPS good (±${Math.round(accuracy)} m)`, 'ok');
  if (session.paused) return;
  const p = [latitude, longitude, t];
  if (session.last) {
    const d = haversine(session.last, p);
    const dt = (t - session.last[2]) / 1000;
    if (d < Math.max(3, accuracy * 0.3)) return;   // jitter while standing still
    if (dt > 0 && d / dt > 12) return;             // impossible jump (> 43 km/h)
    session.distM += d;
  }
  session.last = p;
  session.points.push(p);
  checkSplit();
}

function checkSplit() {
  while (session.distM >= session.nextSplit) {
    const now = elapsedSec();
    const splitSec = now - session.lastSplitSec;
    session.splits.push(Math.round(splitSec));
    session.lastSplitSec = now;
    const n = session.splits.length;
    say(`${n} ${settings.units === 'mi' ? (n > 1 ? 'miles' : 'mile') : (n > 1 ? 'kilometres' : 'kilometre')}. ` +
      `Time ${speakTime(now)}. Last split ${speakTime(splitSec)}.`);
    session.nextSplit += unitM();
  }
}
function speakTime(sec) {
  sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, `${s} seconds`].filter(Boolean).join(' ');
}

function currentSeg() {
  const segs = session.workout.segments, e = elapsedSec();
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (e < acc + segs[i][1]) return { idx: i, type: segs[i][0], left: acc + segs[i][1] - e, len: segs[i][1] };
    acc += segs[i][1];
  }
  return { idx: segs.length, type: 'done', left: 0, len: 1 };
}

function currentPace() {
  const pts = session.points;
  if (pts.length < 2) return NaN;
  const now = pts[pts.length - 1][2];
  let d = 0, i = pts.length - 1;
  while (i > 0 && now - pts[i - 1][2] <= 30000) { d += haversine(pts[i - 1], pts[i]); i--; }
  const dt = (now - pts[i][2]) / 1000;
  if (dt < 8 || d < 10) return NaN;
  return dt / (d / unitM());
}

function tick() {
  if (!session) return;
  const e = elapsedSec();
  $('statDistance').textContent = fmtDist(session.distM);
  $('statTime').textContent = fmtTime(e);
  $('statPace').textContent = session.paused ? '–' : fmtPace(currentPace());
  $('statAvg').textContent = session.distM > 50 ? fmtPace(e / (session.distM / unitM())) : '–';
  drawRoute($('routeSvg'), session.points);
  if (session.workout) tickWorkout();
  if (Math.floor(e) % 10 === 0) { session.savedAt = Date.now(); LS.set('active', session); } // crash/reload recovery
}

function tickWorkout() {
  const w = session.workout, seg = currentSeg(), segs = w.segments;
  const banner = $('workoutBanner');
  if (seg.idx !== session.segIdx) {
    session.segIdx = seg.idx;
    if (seg.type === 'done') {
      if (!session.workoutDone) {
        session.workoutDone = true;
        say('Workout complete! Brilliant job. Press finish to save your run.');
        beep(1046, 0.2, 3); buzz([300, 100, 300, 100, 600]);
      }
    } else {
      const s = segs[seg.idx];
      const msg = s[0] === 'run' ? `Start running for ${fmtDur(s[1])}.`
        : s[0] === 'walk' ? `Walk for ${fmtDur(s[1])}.`
        : s[0] === 'warmup' ? `Week ${w.week}, workout ${w.day}. Begin with a ${fmtDur(s[1])} brisk warm-up walk.`
        : `Great work! Cool down with a ${fmtDur(s[1])} walk.`;
      if (seg.idx > 0) { beep(s[0] === 'run' ? 1046 : 660, 0.18, 2); buzz(s[0] === 'run' ? [400, 150, 400] : [600]); }
      say(msg);
    }
  }
  // Halfway cue for long runs
  if (seg.type === 'run' && seg.len >= 600 && !session['half' + seg.idx] && seg.left <= seg.len / 2) {
    session['half' + seg.idx] = true; say('Halfway there. Keep it up!');
  }
  // Countdown beeps for the last 3 seconds of a segment
  const leftInt = Math.ceil(seg.left);
  if (seg.type !== 'done' && leftInt <= 3 && leftInt >= 1 && session.lastCount !== `${seg.idx}-${leftInt}`) {
    session.lastCount = `${seg.idx}-${leftInt}`; beep(520, 0.08, 1);
  }
  banner.className = 'banner ' + seg.type;
  if (seg.type === 'done') {
    $('segLabel').textContent = 'Workout complete 🎉';
    $('segTime').textContent = fmtTime(elapsedSec());
    $('segNext').textContent = 'Tap Finish to save';
    $('segProgress').style.width = '100%';
  } else {
    $('segLabel').textContent = `${SEG_NAME[seg.type]} · W${w.week} D${w.day}`;
    $('segTime').textContent = fmtTime(seg.left);
    $('segProgress').style.width = (100 * (1 - seg.left / seg.len)).toFixed(1) + '%';
    const nx = segs[seg.idx + 1];
    $('segNext').textContent = nx ? `Next: ${SEG_NAME[nx[0]]} ${fmtTime(nx[1])}` : 'Last one!';
  }
}

function togglePause() {
  if (!session) return;
  if (session.paused) {
    session.paused = false; session.resumedAt = Date.now(); session.last = null; // don't count distance moved while paused
    $('btnPause').textContent = 'Pause'; say('Resumed.'); acquireWake();
  } else {
    session.accMs += Date.now() - session.resumedAt; session.paused = true;
    $('btnPause').textContent = 'Resume'; say('Paused.'); releaseWake();
  }
  tick();
}

function finishRun() {
  if (!session) return;
  if (!session.paused) { session.accMs += Date.now() - session.resumedAt; session.paused = true; }
  const dur = Math.round(session.accMs / 1000);
  clearInterval(tickTimer); stopGps(); releaseWake();
  try { speechSynthesis.cancel(); } catch {}
  const s = session;
  if (dur < 10 && s.distM < 20) { resetRunUi(); toast('Run too short: not saved'); return; }
  const run = {
    id: 'r' + s.startedAt, date: new Date(s.startedAt).toISOString(), dur, distM: Math.round(s.distM),
    splits: s.splits, route: simplify(s.points.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]), 400),
    plan: s.workout ? planKey(s.workout.week, s.workout.day) : null,
    planComplete: s.workout ? s.workoutDone : false
  };
  openRunDialog(run, false);
}

function resetRunUi() {
  session = null; LS.del('active');
  $('controlsIdle').classList.remove('hidden');
  $('controlsActive').classList.add('hidden');
  $('workoutBanner').classList.add('hidden');
  $('statDistance').textContent = fmtDist(0);
  $('statTime').textContent = '0:00';
  $('statPace').textContent = '–'; $('statAvg').textContent = '–';
  drawRoute($('routeSvg'), []);
  setGps('GPS idle');
  updatePlanButton();
}

// Keep the route light for storage: sample down to max N points
function simplify(pts, max) {
  if (pts.length <= max) return pts;
  const step = pts.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

function drawRoute(svg, pts) {
  if (!pts || pts.length < 2) {
    svg.innerHTML = `<text x="150" y="85" text-anchor="middle" fill="#5d6370" font-size="12">${session ? 'Your route will appear here' : 'Route map'}</text>`;
    return;
  }
  const lats = pts.map(p => p[0]), lngs = pts.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = (maxLng - minLng) * k || 1e-6, h = (maxLat - minLat) || 1e-6;
  const W = 300, H = 160, padd = 14;
  const sc = Math.min((W - 2 * padd) / w, (H - 2 * padd) / h);
  const ox = (W - w * sc) / 2, oy = (H - h * sc) / 2;
  const xy = p => [ox + (p[1] - minLng) * k * sc, H - (oy + (p[0] - minLat) * sc)];
  const d = pts.map((p, i) => (i ? 'L' : 'M') + xy(p).map(n => n.toFixed(1)).join(' ')).join('');
  const [sx, sy] = xy(pts[0]), [ex, ey] = xy(pts[pts.length - 1]);
  svg.innerHTML = `<path d="${d}" fill="none" stroke="#ff5a36" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx}" cy="${sy}" r="5" fill="#3ccf8e"/><circle cx="${ex}" cy="${ey}" r="5" fill="#fff" stroke="#ff5a36" stroke-width="2"/>`;
}

/* ---------- Save dialog ---------- */
let dlgRun = null, dlgFeel = 0, dlgManual = false;
function openRunDialog(run, manual) {
  dlgRun = run; dlgManual = manual; dlgFeel = 0;
  document.querySelectorAll('#feelPicker button').forEach(b => b.classList.remove('sel'));
  $('dlgNotes').value = '';
  if (manual) {
    $('dlgTitle').textContent = 'Log a run';
    const today = new Date().toISOString().slice(0, 10);
    $('dlgBody').innerHTML = `
      <label class="col">Date<input type="date" id="mDate" value="${today}" max="${today}"></label>
      <label class="col">Distance (${unitShort()})<input type="number" id="mDist" step="0.01" min="0" inputmode="decimal" style="width:100%;text-align:left"></label>
      <label class="col">Duration (minutes)<input type="number" id="mDur" step="1" min="1" inputmode="numeric" style="width:100%;text-align:left"></label>`;
    $('dlgCancel').textContent = 'Cancel';
  } else {
    $('dlgTitle').textContent = run.planComplete ? 'Workout complete! 🎉' : 'Nice run! 👏';
    const needDist = run.distM < 50;
    const pace = run.distM > 50 ? fmtPace(run.dur / (run.distM / unitM())) : '–';
    const splitsHtml = run.splits.length ? `<div class="splits">${run.splits.map((s, i) =>
      `<div><span>${unitShort()} ${i + 1}</span><span>${fmtPace(s)} /${unitShort()}</span></div>`).join('')}</div>` : '';
    $('dlgBody').innerHTML = `<div class="summary-grid">
      <div><b>${fmtDist(run.distM)}</b><span>${unitLong()}</span></div>
      <div><b>${fmtTime(run.dur)}</b><span>time</span></div>
      <div><b>${pace}</b><span>avg pace /${unitShort()}</span></div>
      <div><b>${run.plan ? run.plan.toUpperCase().replace('D', ' D') : 'Free run'}</b><span>${run.plan ? (run.planComplete ? 'plan workout ✓' : 'not finished') : 'workout'}</span></div>
    </div>${splitsHtml}${needDist ? `
      <label class="col">No GPS distance recorded. How far did you go? (${unitShort()}, optional)
      <input type="number" id="fixDist" step="0.01" min="0" inputmode="decimal" style="width:100%;text-align:left"></label>` : ''}`;
    $('dlgCancel').textContent = 'Discard';
  }
  $('dlg').showModal();
}
document.querySelectorAll('#feelPicker button').forEach(b => b.addEventListener('click', () => {
  dlgFeel = +b.dataset.v;
  document.querySelectorAll('#feelPicker button').forEach(x => x.classList.toggle('sel', x === b));
}));
$('dlgSave').addEventListener('click', e => {
  if (dlgManual) {
    const dist = parseFloat($('mDist').value), dur = parseFloat($('mDur').value), date = $('mDate').value;
    if (!(dist > 0) || !(dur > 0) || !date) { e.preventDefault(); toast('Enter distance and duration'); return; }
    dlgRun = { id: 'm' + Date.now(), date: new Date(date + 'T12:00:00').toISOString(), dur: Math.round(dur * 60),
      distM: Math.round(dist * unitM()), splits: [], route: [], plan: null, manual: true };
  }
  const fix = $('fixDist');
  if (!dlgManual && fix && parseFloat(fix.value) > 0) dlgRun.distM = Math.round(parseFloat(fix.value) * unitM());
  dlgRun.feel = dlgFeel || null;
  dlgRun.notes = $('dlgNotes').value.trim();
  const prevBest = bestStats();
  runs.push(dlgRun); runs.sort((a, b) => b.date.localeCompare(a.date)); saveRuns();
  if (dlgRun.plan && dlgRun.planComplete) { planDone[dlgRun.plan] = dlgRun.id; savePlan(); }
  celebrate(dlgRun, prevBest);
  if (!dlgManual) resetRunUi();
  renderHistory();
});
$('dlgCancel').addEventListener('click', async () => {
  if (!dlgManual) {
    if (!(await ask('Discard this run? It won\'t be saved.', 'Discard', 'Keep it'))) { $('dlg').showModal(); return; }
    resetRunUi();
  }
});
$('dlg').addEventListener('cancel', e => { if (!dlgManual) e.preventDefault(); }); // don't lose a run via back/Esc

function bestStats() {
  let longest = 0, bestPace = Infinity;
  for (const r of runs) {
    longest = Math.max(longest, r.distM);
    if (r.distM >= 1000) bestPace = Math.min(bestPace, r.dur / r.distM);
  }
  return { longest, bestPace };
}
function celebrate(run, prev) {
  if (runs.length === 1) return toast('First run logged! The journey begins 🏁');
  if (run.distM > prev.longest && prev.longest > 0) return toast('New longest run! 🏆');
  if (run.distM >= 1000 && run.dur / run.distM < prev.bestPace && isFinite(prev.bestPace)) return toast('New best pace! ⚡');
  toast('Run saved 💪');
}

/* ---------- Plan view ---------- */
function renderPlan() {
  const total = PLAN.length * 3;
  const done = Object.keys(planDone).filter(k => planDone[k]).length;
  $('planProgress').style.width = (100 * done / total) + '%';
  const next = nextPlanWorkout();
  $('planProgressText').textContent = next
    ? `${done} of ${total} workouts done · Up next: Week ${next.week}, Day ${next.day}`
    : `All ${total} workouts done. You've graduated! 🎓`;
  $('planList').innerHTML = PLAN.map(wk => {
    const isCur = next && next.week === wk.week;
    const days = wk.workouts.map((segs, i) => {
      const key = planKey(wk.week, i + 1), d = describeWorkout(segs), isDone = !!planDone[key];
      const isNext = next && next.week === wk.week && next.day === i + 1;
      return `<div class="day ${isDone ? 'done' : ''}">
        <button class="check" data-toggle="${key}" aria-label="Mark done">${isDone ? '✓' : ''}</button>
        <div class="desc">Day ${i + 1}: ${d.txt}<small>${d.sub}</small></div>
        <button class="btn ${isNext ? 'primary' : ''} go" data-go="${wk.week}-${i + 1}">${isNext ? 'Start' : 'Go'}</button>
      </div>`;
    }).join('');
    return `<div class="week ${isCur ? 'current' : ''}"><div class="week-head"><h3>Week ${wk.week}</h3>
      <span class="muted small">${wk.workouts.filter((_, i) => planDone[planKey(wk.week, i + 1)]).length}/3</span></div>
      <p class="muted">${wk.tip}</p>${days}</div>`;
  }).join('');
}
$('planList').addEventListener('click', e => {
  const t = e.target.closest('[data-toggle]'), g = e.target.closest('[data-go]');
  if (t) { const k = t.dataset.toggle; if (planDone[k]) delete planDone[k]; else planDone[k] = 'manual'; savePlan(); renderPlan(); updatePlanButton(); }
  if (g) {
    if (session) return toast('Finish your current run first');
    const [w, d] = g.dataset.go.split('-').map(Number);
    startRun({ week: w, day: d, segments: PLAN[w - 1].workouts[d - 1] });
  }
});
function updatePlanButton() {
  const n = nextPlanWorkout();
  $('btnStartPlan').textContent = n ? `Start plan: Week ${n.week}, Day ${n.day}` : 'Plan complete 🎓';
  $('btnStartPlan').disabled = !n;
}

/* ---------- History view ---------- */
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

function renderHistory() {
  const u = unitShort();
  const totalM = runs.reduce((a, r) => a + r.distM, 0);
  $('totDist').textContent = `${(totalM / unitM()).toFixed(1)} ${u}`;
  $('totRuns').textContent = runs.length;
  const b = bestStats();
  $('bestPace').textContent = isFinite(b.bestPace) ? `${fmtPace(b.bestPace * unitM())} /${u}` : '–';
  $('longest').textContent = b.longest ? `${fmtDist(b.longest)} ${u}` : '–';

  // Weekly buckets (last 8 weeks)
  const thisWeek = weekStart(new Date()).getTime(), WK = 7 * 864e5;
  const buckets = Array(8).fill(0);
  for (const r of runs) {
    const idx = Math.round((thisWeek - weekStart(r.date).getTime()) / WK);
    if (idx >= 0 && idx < 8) buckets[7 - idx] += r.distM / unitM();
  }
  const cur = buckets[7], goal = +settings.goal || 0;
  $('weekGoalBar').style.width = goal ? Math.min(100, 100 * cur / goal) + '%' : '0';
  $('weekGoalText').textContent = goal
    ? `${cur.toFixed(1)} of ${goal} ${u}${cur >= goal ? ' · Goal smashed! 🎯' : ` · ${(goal - cur).toFixed(1)} ${u} to go`}`
    : `${cur.toFixed(1)} ${u} this week`;
  drawWeekChart(buckets, goal);

  // Streak: consecutive weeks with at least one run
  const weeksWithRuns = new Set(runs.map(r => Math.round((thisWeek - weekStart(r.date).getTime()) / WK)));
  let streak = 0, i = weeksWithRuns.has(0) ? 0 : 1;
  while (weeksWithRuns.has(i)) { streak++; i++; }
  $('streakText').textContent = streak
    ? `🔥 ${streak} week${streak > 1 ? 's' : ''} in a row with at least one run.${weeksWithRuns.has(0) ? '' : ' Run this week to keep it going!'}`
    : 'Log a run to start a weekly streak.';

  $('runList').innerHTML = runs.length ? runs.map(r => {
    const d = new Date(r.date);
    const pace = r.distM > 50 ? `${fmtPace(r.dur / (r.distM / unitM()))} /${u}` : '';
    return `<div class="run-item">
      <div class="feel-e">${r.feel ? FEEL[r.feel] : '🏃'}</div>
      <div class="main"><div class="t">${fmtDist(r.distM)} ${u} · ${fmtTime(r.dur)}</div>
      <div class="s">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}${pace ? ' · ' + pace : ''}${r.plan ? ' · ' + r.plan.toUpperCase() : ''}${r.manual ? ' · manual' : ''}</div>
      ${r.notes ? `<div class="s">${escapeHtml(r.notes)}</div>` : ''}</div>
      <button class="del" data-del="${r.id}" aria-label="Delete">×</button></div>`;
  }).join('') : '<div class="empty">No runs yet. Lace up and hit Start! 👟</div>';
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function drawWeekChart(vals, goal) {
  const W = 320, H = 140, top = 14, bottom = 22, left = 6, bw = (W - left * 2) / vals.length;
  const max = Math.max(goal || 0, ...vals, 1);
  const thisWeek = weekStart(new Date());
  let html = '';
  if (goal) {
    const gy = top + (H - top - bottom) * (1 - goal / max);
    html += `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" stroke="#ffb03b" stroke-dasharray="4 4" stroke-width="1"/>
      <text x="${W - 4}" y="${gy - 4}" text-anchor="end" fill="#ffb03b" font-size="10">goal</text>`;
  }
  vals.forEach((v, i) => {
    const h = (H - top - bottom) * (v / max), x = left + i * bw + 6, y = H - bottom - h;
    const d = new Date(thisWeek); d.setDate(d.getDate() - (7 - i) * 7);
    html += `<rect x="${x}" y="${y}" width="${bw - 12}" height="${Math.max(h, 2)}" rx="4" fill="${i === 7 ? '#ff5a36' : '#3a3f4b'}"/>`;
    if (v > 0) html += `<text x="${x + (bw - 12) / 2}" y="${y - 4}" text-anchor="middle" fill="#9aa0ab" font-size="10">${v.toFixed(1)}</text>`;
    html += `<text x="${x + (bw - 12) / 2}" y="${H - 6}" text-anchor="middle" fill="#5d6370" font-size="10">${i === 7 ? 'now' : d.getDate() + '/' + (d.getMonth() + 1)}</text>`;
  });
  $('weekChart').innerHTML = html;
}

$('runList').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (!(await ask('Delete this run?', 'Delete'))) return;
  const id = b.dataset.del;
  runs = runs.filter(r => r.id !== id); saveRuns();
  for (const k in planDone) if (planDone[k] === id) delete planDone[k];
  savePlan(); renderHistory(); updatePlanButton();
});
$('btnAddManual').addEventListener('click', () => openRunDialog(null, true));

/* ---------- Settings ---------- */
function loadSettingsUi() {
  $('setUnits').value = settings.units; $('setGoal').value = settings.goal;
  $('setVoice').checked = settings.voice; $('setVibrate').checked = settings.vibrate; $('setWake').checked = settings.wake;
  $('unitLabel').textContent = unitLong();
  document.querySelectorAll('.pu').forEach(el => el.textContent = '/' + unitShort());
}
$('setUnits').addEventListener('change', e => {
  const old = unitM(); settings.units = e.target.value;
  settings.goal = Math.round((settings.goal * old / unitM()) * 2) / 2; // convert goal to new unit
  saveSettings(); loadSettingsUi(); if (!session) $('statDistance').textContent = fmtDist(0);
});
$('setGoal').addEventListener('change', e => { settings.goal = Math.max(0, parseFloat(e.target.value) || 0); saveSettings(); });
['voice', 'vibrate', 'wake'].forEach(k => $('set' + k[0].toUpperCase() + k.slice(1)).addEventListener('change', e => { settings[k] = e.target.checked; saveSettings(); }));

let hostDownloads = null;
if (window.claude && window.claude.use) window.claude.use('downloads').then(d => { hostDownloads = d; }).catch(() => {});
$('btnExport').addEventListener('click', async () => {
  const json = JSON.stringify({ app: 'stride', version: 1, settings, runs, planDone }, null, 2);
  const filename = `stride-backup-${new Date().toISOString().slice(0, 10)}.json`;
  if (hostDownloads) {
    try { await hostDownloads.save({ filename, data: json }); toast('Backup saved ✓'); } catch { toast('Backup not saved'); }
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('fileImport').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'stride' || !Array.isArray(data.runs)) throw new Error();
    if (!(await ask(`Import ${data.runs.length} runs? This replaces your current data.`, 'Import'))) return;
    runs = data.runs; planDone = data.planDone || {}; Object.assign(settings, data.settings || {});
    saveRuns(); savePlan(); saveSettings(); loadSettingsUi(); updatePlanButton(); toast('Backup restored ✓');
  } catch { toast('That doesn\'t look like a Stride backup'); }
  e.target.value = '';
});
$('btnReset').addEventListener('click', async () => {
  if (!(await ask('Delete ALL runs and plan progress? This cannot be undone.', 'Delete everything'))) return;
  runs = []; planDone = {}; saveRuns(); savePlan(); updatePlanButton(); toast('All data deleted');
});

/* ---------- Wire up run controls ---------- */
$('btnStart').addEventListener('click', () => startRun(null));
$('btnStartPlan').addEventListener('click', () => {
  const n = nextPlanWorkout(); if (!n) return;
  startRun({ week: n.week, day: n.day, segments: PLAN[n.week - 1].workouts[n.day - 1] });
});
$('btnPause').addEventListener('click', togglePause);
$('btnStop').addEventListener('click', async () => { if (await ask('Finish this run?', 'Finish', 'Keep going')) finishRun(); });
window.addEventListener('beforeunload', e => { if (session) { session.savedAt = Date.now(); LS.set('active', session); e.preventDefault(); e.returnValue = ''; } });

/* ---------- Boot ---------- */
loadSettingsUi();
updatePlanButton();
drawRoute($('routeSvg'), []);

// Recover a run interrupted by the phone closing the tab
const saved = LS.get('active', null);
if (saved && saved.startedAt) {
  if (!saved.paused) { saved.accMs += Math.max(0, (saved.savedAt || saved.resumedAt) - saved.resumedAt); saved.paused = true; }
  ask('You have an unfinished run. Continue it?', 'Continue run', 'Save it as is').then(cont => { if (cont) {
    session = saved; session.last = null;
    startGps(); tickTimer = setInterval(tick, 500);
    $('controlsIdle').classList.add('hidden'); $('controlsActive').classList.remove('hidden');
    $('btnPause').textContent = 'Resume';
    $('workoutBanner').classList.toggle('hidden', !session.workout);
    tick(); toast('Run restored (paused). Tap Resume.');
  } else {
    session = saved; finishRun();
  } });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
