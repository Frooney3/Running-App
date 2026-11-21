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
let profile = LS.get('profile', null);
let adapt = LS.get('adapt', null);

const saveSettings = () => LS.set('settings', settings);
const saveRuns = () => LS.set('runs', runs);
const savePlan = () => { LS.set('planDone', planDone); LS.set('profile', profile); LS.set('adapt', adapt); };

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
function toast(msg, ms = 2400) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
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
const SEG_NAME = {
  warmup: 'Warm-up walk', cooldown: 'Cool-down walk', run: 'Run', walk: 'Walk', easy: 'Easy running', long: 'Long run',
  tempo: 'Tempo', fast: 'Fast', recover: 'Recover', steady: 'Race pace', race: 'Race pace', jogwarm: 'Warm-up jog', jogcool: 'Cool-down jog'
};
const BANNER_CLASS = { run: 'run', fast: 'run', tempo: 'run', race: 'run', steady: 'run', easy: 'easy', long: 'easy' };
function currentPlan() { return profile ? Planner.build(profile, adapt, planDone) : null; }
function nextPlanWorkout() { const b = currentPlan(); return b ? b.next : null; }
function paceRange(type) {
  const p = profile && Planner.paces(profile); if (!p || !p[type]) return '';
  const k = unitM() / 1000;
  return `${fmtPace(p[type][0] * k)}–${fmtPace(p[type][1] * k)} /${unitShort()}`;
}
function spokenPace(type) {
  const p = profile && Planner.paces(profile); if (!p || !p[type] || type === 'recover') return '';
  const sec = Math.round((p[type][0] + p[type][1]) / 2 * unitM() / 1000);
  return ` Aim for about ${Math.floor(sec / 60)} ${pad(sec % 60)} per ${settings.units === 'mi' ? 'mile' : 'kilometre'}.`;
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
      const s = segs[seg.idx], d = fmtDur(s[1]);
      const CUE = {
        run: `Start running for ${d}.`, walk: `Walk for ${d}.`, warmup: `Begin with a ${d} brisk warm-up walk.`,
        cooldown: `Great work! Cool down with a ${d} walk.`, easy: `Easy running for ${d}.`,
        long: `Long run, ${d}. Settle into a relaxed pace.`, tempo: `Tempo for ${d}. Comfortably hard.`,
        fast: `Go! Fast for ${d}.`, recover: `Recover. Easy jog for ${d}.`, steady: `Race pace for ${d}.`,
        race: `Race pace for ${d}.`, jogwarm: `Warm up with an easy jog for ${d}.`, jogcool: `Nice work! Cool down with an easy jog for ${d}.`
      };
      const msg = (seg.idx === 0 ? `${w.title}. ` : '') + (CUE[s[0]] || `${SEG_NAME[s[0]]} for ${d}.`) + spokenPace(s[0]);
      const hard = BANNER_CLASS[s[0]] === 'run';
      if (seg.idx > 0) { beep(hard ? 1046 : 660, 0.18, 2); buzz(hard ? [400, 150, 400] : [600]); }
      say(msg);
    }
  }
  // Halfway cue for long runs
  if (['run', 'long', 'tempo', 'steady', 'easy'].includes(seg.type) && seg.len >= 600 && !session['half' + seg.idx] && seg.left <= seg.len / 2) {
    session['half' + seg.idx] = true; say('Halfway there. Keep it up!');
  }
  // Countdown beeps for the last 3 seconds of a segment
  const leftInt = Math.ceil(seg.left);
  if (seg.type !== 'done' && leftInt <= 3 && leftInt >= 1 && session.lastCount !== `${seg.idx}-${leftInt}`) {
    session.lastCount = `${seg.idx}-${leftInt}`; beep(520, 0.08, 1);
  }
  banner.className = 'banner ' + (seg.type === 'done' ? 'done' : BANNER_CLASS[seg.type] || 'walk');
  if (seg.type === 'done') {
    $('segLabel').textContent = 'Workout complete 🎉';
    $('segTime').textContent = fmtTime(elapsedSec());
    $('segNext').textContent = 'Tap Finish to save';
    $('segProgress').style.width = '100%';
  } else {
    $('segLabel').textContent = `${SEG_NAME[seg.type]} · ${w.short || ''}`;
    $('segTime').textContent = fmtTime(seg.left);
    $('segProgress').style.width = (100 * (1 - seg.left / seg.len)).toFixed(1) + '%';
    const nx = segs[seg.idx + 1];
    const tgt = paceRange(seg.type);
    $('segNext').textContent = (tgt ? `Target ${tgt} · ` : '') + (nx ? `Next: ${SEG_NAME[nx[0]]} ${fmtTime(nx[1])}` : 'Last one!');
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
    plan: s.workout ? s.workout.key : null, planTitle: s.workout ? s.workout.title : null,
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
      <div><b style="font-size:15px">${run.plan ? escapeHtml(run.planTitle || 'Plan workout') : 'Free run'}</b><span>${run.plan ? (run.planComplete ? 'plan workout ✓' : 'stopped early') : 'workout'}</span></div>
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
  if (dlgRun.plan && dlgRun.planComplete) planDone[dlgRun.plan] = dlgRun.id;
  const msgs = [];
  if (profile) {
    msgs.push(...Planner.afterRun(profile, adapt, dlgRun, planDone, runs));
    const fit = Planner.updateFitness(profile, adapt, dlgRun); if (fit) msgs.push(fit);
  }
  savePlan();
  if (msgs.length) toast(msgs.join(' '), 6000); else celebrate(dlgRun, prevBest);
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
const shortDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); };

function workoutRow(wo, isNext) {
  const isDone = !!planDone[wo.key];
  const when = wo.date ? `${shortDate(wo.date)} · ` : '';
  return `<div class="day ${isDone ? 'done' : ''}">
    <button class="check" data-toggle="${wo.key}" aria-label="Mark done">${isDone ? '✓' : ''}</button>
    <div class="desc">${escapeHtml(wo.title)}<small>${when}${escapeHtml(wo.desc)}</small></div>
    <button class="btn ${isNext ? 'primary' : ''} go" data-go="${wo.key}">${isNext ? 'Start' : 'Go'}</button>
  </div>`;
}

function renderPlan() {
  const root = $('planRoot');
  if (!profile) {
    const oldDone = Object.keys(planDone).length;
    root.innerHTML = `<div class="card hero-card">
      <h2>Your personal training plan</h2>
      <p class="muted">Answer a few quick questions: what you're aiming for, how fit you are now, and when you can run.
      Stride builds a plan around you, then keeps adjusting it as you log runs.</p>
      <ul class="tips">
        <li>Tough run? Upcoming sessions get eased.</li>
        <li>Flying? It nudges you on.</li>
        <li>Had a break? It eases you back in.</li>
        <li>Getting faster? Your target paces update.</li>
      </ul>
      <button class="btn primary big" id="btnBuildPlan" style="margin-top:14px">Build my plan</button>
      ${oldDone ? `<p class="muted small">Your ${oldDone} completed Couch-to-5K workouts will carry over.</p>` : ''}
    </div>`;
    $('btnBuildPlan').onclick = openWizard;
    return;
  }

  const b = currentPlan(); savePlan();
  const G = Planner.GOALS[profile.goal];
  const t5 = Planner.fiveK(profile);
  let status;
  if (b.phase === 'beginner') status = b.graduated ? 'Run/walk programme complete 🎓' : `Run/walk phase · week ${b.current + 1} of ${b.total}`;
  else status = b.finished ? 'Plan complete 🎉' : `Week ${b.current + 1} of ${b.total}`;
  const raceDays = profile.raceDate ? Math.round((new Date(profile.raceDate + 'T00:00') - new Date(new Date().toDateString())) / 864e5) : null;
  const doneCount = b.weeks.reduce((a, w) => a + w.workouts.filter(x => planDone[x.key]).length, 0);
  const totalCount = b.weeks.reduce((a, w) => a + w.workouts.length, 0);
  const intensity = Math.round(adapt.load * 100);

  let html = `<div class="card">
    <div class="goal-head"><div><div class="eyebrow">Goal</div><h2>${G.label}</h2></div>
      <button class="btn ghost small-btn" id="btnEditPlan">Edit</button></div>
    <p class="muted small">${status}${raceDays !== null && raceDays >= 0 ? ` · race in ${raceDays} day${raceDays === 1 ? '' : 's'}` : ''}</p>
    <div class="progress-wrap"><div class="progress" style="width:${100 * doneCount / Math.max(1, totalCount)}%"></div></div>
    <div class="facts">
      ${t5 ? `<div><span>Est. 5K</span><b>${Planner.mmss(t5)}</b></div>` : ''}
      ${paceRange('easy') ? `<div><span>Easy pace</span><b>${paceRange('easy')}</b></div>` : ''}
      ${b.phase === 'runner' ? `<div><span>Intensity</span><b>${intensity}%</b></div>` : ''}
      <div><span>Runs / week</span><b>${b.phase === 'beginner' ? Math.min(3, profile.days) : profile.days}</b></div>
    </div>
    ${!t5 ? '<p class="muted small">Tip: add a recent race or time-trial result (Edit) to get target paces. A GPS run over 2 km will also set them.</p>' : ''}
  </div>`;

  if (b.graduated || b.finished) {
    html += `<div class="card"><h2>${b.finished ? 'You did it! 🎉' : 'You\'re a runner! 🎓'}</h2>
      <p class="muted">Time for a new challenge. Your fitness and history carry over.</p>
      <button class="btn primary" id="btnNewGoal">Set a new goal</button></div>`;
  } else if (b.next) {
    const n = b.next;
    html += `<div class="card next-card"><div class="eyebrow">Up next${n.date ? ' · ' + shortDate(n.date) : ''}</div>
      <h2>${escapeHtml(n.title)}</h2><p class="muted small">${escapeHtml(n.desc)}</p>
      ${segmentStrip(n.segments)}
      <button class="btn primary" data-go="${n.key}">Start workout</button></div>`;
  } else {
    html += `<div class="card"><h2>Week done ✓</h2><p class="muted small">All of this week's runs are complete. Rest up: next week unlocks on Monday.</p></div>`;
  }

  if (adapt.log.length) {
    html += `<div class="card"><h2>How your plan has adapted</h2><div class="adapt-log">${adapt.log.slice(0, 4).map(l =>
      `<div><span>${shortDate(l.date)}</span>${escapeHtml(l.msg)}</div>`).join('')}</div></div>`;
  }

  html += '<h2 class="section-h">Schedule</h2>';
  b.weeks.forEach((wk, i) => {
    const isCur = i === b.current && !b.graduated && !b.finished;
    const done = wk.workouts.filter(x => planDone[x.key]).length;
    const past = i < b.current;
    html += `<details class="week ${isCur ? 'current' : ''}" ${isCur ? 'open' : ''}>
      <summary class="week-head"><h3>${wk.label}${wk.start ? ` <span class="muted small">· ${shortDate(wk.start)}</span>` : ''}</h3>
      <span class="muted small">${done}/${wk.workouts.length}${past && done < wk.workouts.length ? '' : ''}</span></summary>
      <p class="muted">${escapeHtml(wk.tip)}</p>
      ${wk.workouts.map(wo => workoutRow(wo, b.next && b.next.key === wo.key)).join('')}
      ${i > b.current ? '<p class="muted small">Future weeks adjust automatically as you train.</p>' : ''}
    </details>`;
  });
  root.innerHTML = html;
  $('btnEditPlan').onclick = openWizard;
  const ng = $('btnNewGoal'); if (ng) ng.onclick = openWizard;
}

function segmentStrip(segs) {
  const total = segs.reduce((a, s) => a + s[1], 0);
  return `<div class="seg-strip" aria-hidden="true">${segs.map(s =>
    `<i class="${BANNER_CLASS[s[0]] || 'walk'}" style="flex:${s[1] / total}"></i>`).join('')}</div>`;
}

$('planRoot').addEventListener('click', e => {
  const t = e.target.closest('[data-toggle]'), g = e.target.closest('[data-go]');
  const b = currentPlan(); if (!b) return;
  const all = b.weeks.flatMap(w => w.workouts);
  if (t) {
    const k = t.dataset.toggle;
    if (planDone[k]) delete planDone[k];
    else {
      planDone[k] = 'manual';
      if (profile.phase === 'beginner') { const m = Planner.afterRun(profile, adapt, { plan: k, planComplete: true, feel: 3 }, planDone, runs); if (m.length) toast(m.join(' '), 5000); }
    }
    savePlan(); renderPlan(); updatePlanButton();
  }
  if (g) {
    if (session) return toast('Finish your current run first');
    const wo = all.find(x => x.key === g.dataset.go); if (wo) startRun(wo);
  }
});

function updatePlanButton() {
  const btn = $('btnStartPlan');
  if (!profile) { btn.textContent = 'Build my personal plan'; btn.disabled = false; return; }
  const n = nextPlanWorkout();
  btn.textContent = n ? `Start: ${n.title}` : 'View your plan';
  btn.disabled = false;
}

/* ---------- Plan setup wizard ---------- */
const RECENT_DIST = { '': 0, mile: 1.609344, '5k': 5, '10k': 10, half: 21.0975, marathon: 42.195 };
let wiz = null;

function parseTime(str) {
  const parts = String(str || '').trim().split(':').map(Number);
  if (!parts.length || parts.some(n => isNaN(n))) return null;
  const sec = parts.reduce((a, n) => a * 60 + n, 0);
  return parts.length >= 2 && sec > 0 ? sec : null;
}

function openWizard() {
  const p = profile;
  wiz = {
    step: 0,
    goal: p ? p.goal : (Object.keys(planDone).length ? 'start' : ''),
    continuous: p ? p.continuous : null,
    weeklyKm: p ? p.weeklyKm : 0,
    recentDist: p && p.recent && !p.recent.auto ? Object.keys(RECENT_DIST).find(k => Math.abs(RECENT_DIST[k] - p.recent.distKm) < 0.01) || '' : '',
    recentTime: p && p.recent && !p.recent.auto ? fmtTime(p.recent.sec) : '',
    days: p ? p.days : 3,
    prefDays: p ? [...p.prefDays] : [1, 3, 6],
    raceDate: p ? p.raceDate || '' : ''
  };
  renderWizard();
  $('planDlg').showModal();
}

const GOAL_HINT = {
  start: 'From walking to running 30 minutes non-stop', '5k': 'Get quicker over 5 km', '10k': 'Build up to 10 km and race it',
  half: '21.1 km: a big, achievable goal', marathon: '42.2 km: the ultimate challenge', fitness: 'Regular, balanced running with no race'
};
const FIT_OPTS = [[0, 'I can\'t run yet, or under a minute'], [3, 'A few minutes'], [10, 'About 10 minutes'], [25, '20–30 minutes'], [45, 'About 45 minutes'], [75, 'An hour or more']];

function renderWizard() {
  const w = wiz, u = unitShort();
  const steps = ['Goal', 'Fitness', 'Schedule', 'Date', 'Review'];
  const needDate = ['5k', '10k', 'half', 'marathon'].includes(w.goal);
  let body = '';
  if (w.step === 0) {
    body = `<h2>What are you aiming for?</h2><div class="choices">${Object.entries(Planner.GOALS).map(([k, g]) =>
      `<label class="choice"><input type="radio" name="wGoal" value="${k}" ${w.goal === k ? 'checked' : ''}>
       <span><b>${g.label}</b><small>${GOAL_HINT[k]}</small></span></label>`).join('')}</div>`;
  } else if (w.step === 1) {
    body = `<h2>How fit are you right now?</h2>
      <p class="muted small">Be honest: the plan works best when it starts where you are.</p>
      <div class="q">How long can you run without stopping?</div>
      <div class="choices">${FIT_OPTS.map(([v, t]) => `<label class="choice compact"><input type="radio" name="wFit" value="${v}" ${w.continuous === v ? 'checked' : ''}><span><b>${t}</b></span></label>`).join('')}</div>
      <label class="col">Roughly how far do you run each week now? (${u})
        <input type="number" id="wWeekly" min="0" step="1" inputmode="decimal" value="${w.weeklyKm ? +(w.weeklyKm * 1000 / unitM()).toFixed(1) : ''}" placeholder="0" style="width:100%;text-align:left"></label>
      <div class="q">A recent race or timed run (optional)</div>
      <div class="inline">
        <select id="wRecentDist"><option value="">None</option><option value="mile">1 mile</option><option value="5k">5K</option><option value="10k">10K</option><option value="half">Half marathon</option><option value="marathon">Marathon</option></select>
        <input type="text" id="wRecentTime" placeholder="mm:ss or h:mm:ss" inputmode="numeric" value="${w.recentTime}">
      </div>
      <p class="muted small">Used to set your target paces. Leave blank and Stride will estimate them from your runs.</p>`;
  } else if (w.step === 2) {
    const beginnerish = w.goal === 'start' || w.continuous < 20;
    body = `<h2>When can you run?</h2>
      <div class="q">Runs per week</div>
      <div class="chips">${[2, 3, 4, 5, 6].map(n => `<label class="chip"><input type="radio" name="wDays" value="${n}" ${w.days === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
      ${beginnerish && w.days > 3 ? '<p class="muted small">Starting out, 3 runs a week is the sweet spot. Use the other days for walks or rest.</p>' : ''}
      <div class="q">Which days suit you? <span class="muted small">(pick ${w.days})</span></div>
      <div class="chips">${Planner.DAY_NAMES.map((d, i) => `<label class="chip"><input type="checkbox" name="wPref" value="${i}" ${w.prefDays.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
      <p class="muted small">Your long run goes on the last day you pick.</p>`;
  } else if (w.step === 3) {
    body = needDate ? `<h2>Do you have a race date?</h2>
      <p class="muted small">The plan counts down to it and tapers so you arrive fresh. No date? Leave it blank and you get a ${Planner.GOALS[w.goal].weeks}-week plan.</p>
      <label class="col">Race date<input type="date" id="wRace" value="${w.raceDate}" min="${Planner.ymd(new Date(Date.now() + 14 * 864e5))}"></label>
      ${w.raceDate ? '<button type="button" class="btn ghost" id="wClearRace" style="margin-top:10px">No race date</button>' : ''}`
      : `<h2>No date needed</h2><p class="muted">${w.goal === 'start' ? 'The run/walk programme moves at your pace. Weeks repeat or skip ahead depending on how runs feel.' : 'Your plan runs in 8-week blocks that keep you progressing.'}</p>`;
  } else {
    const prof = Planner.createProfile(wizAnswers(), new Date(), profile);
    body = `<h2>Your plan</h2><ul class="tips">${Planner.preview(prof).map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      <p class="muted small" style="margin-top:12px">After every plan run, rate how it felt. Stride uses that to adjust what comes next.</p>`;
  }
  $('planDlgBody').innerHTML = `<div class="steps">${steps.map((s, i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div>${body}`;
  if (w.step === 1) $('wRecentDist').value = w.recentDist;
  $('wizBack').textContent = w.step === 0 ? 'Cancel' : 'Back';
  $('wizNext').textContent = w.step === 4 ? (profile ? 'Update plan' : 'Create plan') : 'Next';
  const cr = $('wClearRace'); if (cr) cr.onclick = () => { wiz.raceDate = ''; renderWizard(); };
}

function wizAnswers() {
  const w = wiz, km = RECENT_DIST[w.recentDist], sec = parseTime(w.recentTime);
  return {
    goal: w.goal, continuous: w.continuous, weeklyKm: w.weeklyKm, days: w.days, prefDays: w.prefDays,
    recent: km && sec ? { distKm: km, sec } : null,
    raceDate: ['5k', '10k', 'half', 'marathon'].includes(w.goal) && w.raceDate ? w.raceDate : null
  };
}

function collectStep() {
  const w = wiz, f = $('planDlgBody');
  if (w.step === 0) {
    const g = f.querySelector('input[name=wGoal]:checked'); if (!g) return 'Pick a goal';
    w.goal = g.value;
  } else if (w.step === 1) {
    const c = f.querySelector('input[name=wFit]:checked'); if (!c) return 'Choose how long you can run';
    w.continuous = +c.value;
    w.weeklyKm = Math.max(0, parseFloat($('wWeekly').value) || 0) * unitM() / 1000;
    w.recentDist = $('wRecentDist').value; w.recentTime = $('wRecentTime').value.trim();
    if (w.recentDist && !parseTime(w.recentTime)) return 'Enter the time as mm:ss or h:mm:ss';
    if (w.recentDist) {
      const secPerKm = parseTime(w.recentTime) / RECENT_DIST[w.recentDist];
      if (secPerKm < 150 || secPerKm > 900) return 'That time looks off. Check the distance and time.';
    }
  } else if (w.step === 2) {
    w.days = +(f.querySelector('input[name=wDays]:checked') || { value: 3 }).value;
    w.prefDays = [...f.querySelectorAll('input[name=wPref]:checked')].map(i => +i.value);
    if (w.prefDays.length !== w.days) return `Pick ${w.days} days (you picked ${w.prefDays.length})`;
  } else if (w.step === 3) {
    const r = $('wRace'); if (r) w.raceDate = r.value;
  }
  return null;
}

$('planDlgBody').addEventListener('change', e => {
  // live-refresh step 2 hints when the count changes
  if (wiz && wiz.step === 2 && e.target.name === 'wDays') { wiz.days = +e.target.value; wiz.prefDays = wiz.prefDays.slice(0, 7); renderWizardKeep(); }
});
function renderWizardKeep() {
  const pref = [...$('planDlgBody').querySelectorAll('input[name=wPref]:checked')].map(i => +i.value);
  wiz.prefDays = pref; renderWizard();
}

$('wizNext').addEventListener('click', () => {
  const err = collectStep(); if (err) return toast(err);
  if (wiz.step < 4) { wiz.step++; renderWizard(); return; }
  const prev = profile;
  profile = Planner.createProfile(wizAnswers(), new Date(), prev);
  adapt = Planner.freshAdapt(adapt, profile, planDone);
  adapt.log.unshift({ date: Planner.ymd(new Date()), msg: `${prev ? 'Plan updated' : 'Plan created'}: ${Planner.GOALS[profile.goal].label.toLowerCase()}.` });
  savePlan(); $('planDlg').close(); renderPlan(); updatePlanButton();
  toast(prev ? 'Plan updated ✓' : 'Your plan is ready! 🏃', 3000);
});
$('wizBack').addEventListener('click', () => {
  if (wiz.step === 0) { $('planDlg').close(); return; }
  collectStep(); wiz.step--; renderWizard();
});

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
      <div class="s">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}${pace ? ' · ' + pace : ''}${r.plan ? ' · ' + escapeHtml(r.planTitle || 'plan') : ''}${r.manual ? ' · manual' : ''}</div>
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
  const json = JSON.stringify({ app: 'stride', version: 2, settings, runs, planDone, profile, adapt }, null, 2);
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
    runs = data.runs; planDone = data.planDone || {}; profile = data.profile || null; adapt = data.adapt || null; Object.assign(settings, data.settings || {});
    saveRuns(); savePlan(); saveSettings(); loadSettingsUi(); updatePlanButton(); toast('Backup restored ✓');
  } catch { toast('That doesn\'t look like a Stride backup'); }
  e.target.value = '';
});
$('btnReset').addEventListener('click', async () => {
  if (!(await ask('Delete ALL runs and plan progress? This cannot be undone.', 'Delete everything'))) return;
  runs = []; planDone = {}; profile = null; adapt = null; saveRuns(); savePlan(); updatePlanButton(); toast('All data deleted');
});

/* ---------- Wire up run controls ---------- */
$('btnStart').addEventListener('click', () => startRun(null));
$('btnStartPlan').addEventListener('click', () => {
  if (!profile) { showView('plan'); openWizard(); return; }
  const n = nextPlanWorkout(); if (!n) { showView('plan'); return; }
  startRun(n);
});
$('btnPause').addEventListener('click', togglePause);
$('btnStop').addEventListener('click', async () => { if (await ask('Finish this run?', 'Finish', 'Keep going')) finishRun(); });
window.addEventListener('beforeunload', e => { if (session) { session.savedAt = Date.now(); LS.set('active', session); e.preventDefault(); e.returnValue = ''; } });

/* ---------- Boot ---------- */
loadSettingsUi();
if (profile) {
  const brk = Planner.checkBreak(profile, adapt, runs, planDone);
  if (brk) { savePlan(); setTimeout(() => toast(brk, 6000), 800); }
}
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
