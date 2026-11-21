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
  if (v === 'run') renderHome();
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
    workout: workout || null, workoutDone: false,
    segs: workout ? workout.segments.map(x => {
      const g = Planner.seg(x, profile); const p = profile && Planner.paces(profile);
      g.tgt = p && p[g.type] && g.type !== 'recover' ? p[g.type].map(Math.round) : null; return g;
    }) : null,
    seg: { idx: 0, t0: 0, d0: 0, cued: -1, flags: {} }, steps: []
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
  $('liveStats').classList.remove('hidden');
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
  const w = session.workout, segs = session.segs, e = elapsedSec(), d = session.distM;
  const gpsOff = session.noGps || (e > 60 && session.points.length < 2);
  const st = session.seg;
  const timeMode = s => s.unit === 's' || gpsOff;
  const segDone = s => timeMode(s) ? e - st.t0 >= (s.unit === 's' ? s.amt : s.sec) : d - st.d0 >= s.amt;

  // Advance through finished steps (and record actual results)
  while (st.idx < segs.length && segDone(segs[st.idx])) {
    const s = segs[st.idx];
    session.steps.push({ type: s.type, unit: s.unit, amt: s.amt, sec: Math.round(e - st.t0), m: Math.round(d - st.d0), tgt: s.tgt, gps: !gpsOff });
    st.idx++; st.t0 = e; st.d0 = d; st.flags = {};
  }

  // Cue the step we're on
  if (st.cued !== st.idx) {
    st.cued = st.idx;
    if (st.idx >= segs.length) {
      if (!session.workoutDone) {
        session.workoutDone = true;
        say('Workout complete! Brilliant job. Press finish to save your run.');
        beep(1046, 0.2, 3); buzz([300, 100, 300, 100, 600]);
      }
    } else {
      const s = segs[st.idx], a = amountWords(s);
      const CUE = {
        run: `Start running for ${a}.`, walk: `Walk for ${a}.`, warmup: `Begin with a ${a} brisk warm-up walk.`,
        cooldown: `Great work! Cool down with a ${a} walk.`, easy: `Easy running for ${a}.`,
        long: `Long run, ${a}. Settle into a relaxed pace.`, tempo: `Tempo for ${a}. Comfortably hard.`,
        fast: `Go! Fast for ${a}.`, recover: `Recover. Easy jog for ${a}.`, steady: `Race pace for ${a}.`,
        race: `Race pace for ${a}.`, jogwarm: `Warm up with an easy jog for ${a}.`, jogcool: `Nice work! Cool down with an easy jog for ${a}.`
      };
      const rep = repLabel(st.idx);
      const msg = (st.idx === 0 ? `${w.title}. ` : '') + (rep ? `${rep}. ` : '') + (CUE[s.type] || `${SEG_NAME[s.type]} for ${a}.`) + spokenPace(s.type);
      const hard = BANNER_CLASS[s.type] === 'run';
      if (st.idx > 0) { beep(hard ? 1046 : 660, 0.18, 2); buzz(hard ? [400, 150, 400] : [600]); }
      say(msg);
      session.lastCoach = e;
    }
  }

  const banner = $('workoutBanner');
  if (st.idx >= segs.length) {
    banner.className = 'banner done';
    $('segLabel').textContent = 'Workout complete 🎉';
    $('segTime').textContent = fmtTime(e);
    $('segNext').textContent = 'Tap Finish to save';
    $('segProgress').style.width = '100%';
    $('segPace').className = 'pace-chip hidden';
    return;
  }

  const s = segs[st.idx], tm = timeMode(s);
  const total = tm ? (s.unit === 's' ? s.amt : s.sec) : s.amt;
  const doneAmt = tm ? e - st.t0 : d - st.d0;
  const left = Math.max(0, total - doneAmt), frac = Math.min(1, doneAmt / total);

  // Halfway + closing cues
  st.flags = st.flags || {};
  if (['run', 'long', 'tempo', 'steady', 'easy'].includes(s.type) && s.sec >= 600 && !st.flags.half && frac >= 0.5) { st.flags.half = 1; say('Halfway there. Keep it up!'); }
  if (tm) {
    const li = Math.ceil(left);
    if (li <= 3 && li >= 1 && st.flags.count !== li) { st.flags.count = li; beep(520, 0.08, 1); }
  } else if (s.amt >= 400 && left <= 100 && !st.flags.last100) { st.flags.last100 = 1; say('100 metres to go.'); beep(520, 0.08, 2); }

  // Live pace coaching (needs GPS and a target)
  const chip = $('segPace');
  const now = currentPace() * 1000 / unitM(); // sec per km
  if (s.tgt && !gpsOff && isFinite(now)) {
    const [fast, slow] = s.tgt, k = unitM() / 1000;
    const state = now > slow * 1.03 ? 'slow' : now < fast * 0.97 ? 'fast' : 'on';
    chip.className = 'pace-chip ' + state;
    chip.textContent = `${fmtPace(now * k)} /${unitShort()} · ${state === 'on' ? 'on target ✓' : state === 'slow' ? 'speed up ↑' : 'ease off ↓'}`;
    if (e - st.t0 > 25 && e - (session.lastCoach || 0) > 45) {
      const target = `${speakPace((fast + slow) / 2)}`;
      if (state === 'slow') { say(`Speed up a little. You're at ${speakPace(now)}. Aim for ${target}.`); session.lastCoach = e; }
      else if (state === 'fast') { say(`Ease off a little. You're at ${speakPace(now)}. Aim for ${target}.`); session.lastCoach = e; }
      else if (e - (session.lastOn || 0) > 240) { say('Right on pace. Nice work.'); session.lastCoach = e; session.lastOn = e; }
    }
  } else if (s.tgt) {
    chip.className = 'pace-chip';
    chip.textContent = gpsOff ? 'Target pace shown below · no GPS' : 'Finding your pace…';
  } else chip.className = 'pace-chip hidden';

  banner.className = 'banner ' + (BANNER_CLASS[s.type] || 'walk');
  const rep = repLabel(st.idx);
  $('segLabel').textContent = `${SEG_NAME[s.type]}${rep ? ' · ' + rep : ''} · ${st.idx + 1}/${segs.length}`;
  $('segTime').textContent = tm ? fmtTime(left) : fmtLeftDist(left);
  $('segProgress').style.width = (100 * frac).toFixed(1) + '%';
  const nx = segs[st.idx + 1];
  const tgt = paceRange(s.type);
  $('segNext').textContent = (tgt ? `Target ${tgt} · ` : '') + (nx ? `Next: ${SEG_NAME[nx.type]} ${amountShort(nx)}` : 'Last one!');
}

// "Rep 3 of 6" for repeated hard steps
function repLabel(i) {
  const segs = session.segs, s = segs[i];
  if (!s || BANNER_CLASS[s.type] !== 'run') return '';
  const same = segs.map((x, j) => [x, j]).filter(([x]) => x.type === s.type && x.amt === s.amt && x.unit === s.unit);
  if (same.length < 2) return '';
  return `Rep ${same.findIndex(([, j]) => j === i) + 1} of ${same.length}`;
}
function amountWords(s) {
  if (s.unit === 's') return fmtDur(s.amt);
  if (s.amt < 1000) return `${s.amt} metres`;
  if (settings.units === 'mi') return `${(s.amt / 1609.344).toFixed(1)} miles`;
  const km = s.amt / 1000; return `${+km.toFixed(2)} kilometre${km === 1 ? '' : 's'}`;
}
function amountShort(s) {
  if ((s.unit || 's') === 's') return fmtTime(s.amt);
  if (s.amt < 1000) return `${s.amt} m`;
  return `${+(s.amt / unitM()).toFixed(2)} ${unitShort()}`;
}
function fmtLeftDist(m) {
  if (m < 1000) return `${Math.ceil(m / 10) * 10} m`;
  return `${(m / unitM()).toFixed(2)} ${unitShort()}`;
}
function speakPace(secPerKm) {
  const sec = Math.round(secPerKm * unitM() / 1000);
  return `${Math.floor(sec / 60)} ${pad(sec % 60)}`;
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
  if (s.segs && s.seg.idx < s.segs.length) { // record the step you stopped in
    const g = s.segs[s.seg.idx], t = dur - s.seg.t0;
    if (t >= 10) s.steps.push({ type: g.type, unit: g.unit, amt: g.amt, sec: Math.round(t), m: Math.round(s.distM - s.seg.d0), tgt: g.tgt, gps: !s.noGps && s.points.length > 1, partial: true });
  }
  const run = {
    id: 'r' + s.startedAt, date: new Date(s.startedAt).toISOString(), dur, distM: Math.round(s.distM),
    splits: s.splits, route: simplify(s.points.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]), 400),
    plan: s.workout ? s.workout.key : null, planTitle: s.workout ? s.workout.title : null,
    // Done if every step is finished, or only the cool-down was cut short
    planComplete: s.workout ? (s.workoutDone || (s.seg.idx === s.segs.length - 1 && ['jogcool', 'cooldown'].includes(s.segs[s.seg.idx].type))) : false,
    steps: s.steps && s.steps.length ? s.steps : undefined
  };
  openRunDialog(run, false);
}

function resetRunUi() {
  session = null; LS.del('active');
  $('controlsIdle').classList.remove('hidden');
  $('controlsActive').classList.add('hidden');
  $('workoutBanner').classList.add('hidden');
  $('liveStats').classList.add('hidden');
  $('statDistance').textContent = fmtDist(0);
  $('statTime').textContent = '0:00';
  $('statPace').textContent = '–'; $('statAvg').textContent = '–';
  drawRoute($('routeSvg'), []);
  setGps('GPS idle');
  updatePlanButton();
  renderHome();
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
    </div>${splitsHtml}${analysisHtml(run.steps)}${needDist ? `
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
  renderHistory(); renderHome();
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
  const isDone = !!planDone[wo.key] && planDone[wo.key] !== 'skip';
  const when = wo.date ? `${shortDate(wo.date)} · ` : '';
  return `<div class="day ${isDone ? 'done' : ''}">
    <button class="check" data-toggle="${wo.key}" aria-label="Mark done">${isDone ? '✓' : ''}</button>
    <div class="desc">${escapeHtml(wo.title)}<small>${when}${escapeHtml(wo.desc)}</small></div>
    <button class="btn ${isNext ? 'primary' : ''} go" data-go="${wo.key}">View</button>
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
      <div class="btn-row"><button class="btn ghost" data-go="${n.key}">Details</button><button class="btn primary" data-start="${n.key}">Start workout</button></div></div>`;
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
  const t = e.target.closest('[data-toggle]'), g = e.target.closest('[data-go]'), st = e.target.closest('[data-start]');
  const b = currentPlan(); if (!b) return;
  if (st) { if (session) return toast('Finish your current run first'); const wo = findWorkout(st.dataset.start); if (wo) startRun(wo); return; }
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
    openWorkout(g.dataset.go);
  }
});

function updatePlanButton() {
  const btn = $('btnStartPlan');
  btn.classList.toggle('hidden', !!profile);
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
  savePlan(); $('planDlg').close(); renderPlan(); updatePlanButton(); renderHome();
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
  $('predCard').innerHTML = predictionHtml();
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
    return `<div class="run-item" data-run="${r.id}">
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
  const b = e.target.closest('[data-del]');
  if (!b) { const it = e.target.closest('[data-run]'); if (it) openRunDetail(it.dataset.run); return; }
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

/* ---------- Workout presentation ---------- */
const KIND_LABEL = { easy: 'Easy run', long: 'Long run', tempo: 'Tempo', intervals: 'Intervals', steady: 'Race pace', fartlek: 'Fartlek', race: 'Race day', sharpener: 'Sharpener', runwalk: 'Run/walk' };
const KIND_CLASS = { easy: 'easy', long: 'easy', runwalk: 'easy', tempo: 'run', intervals: 'run', steady: 'run', fartlek: 'run', race: 'run', sharpener: 'run' };
const todayStr = () => Planner.ymd(new Date());

function woEstimate(wo) {
  const s = Planner.summary(wo, profile);
  return `≈ ${Math.round(s.sec / 60)} min · ${(s.m / unitM()).toFixed(1)} ${unitShort()}`;
}
function intensityChart(wo, tall) {
  const segs = Planner.summary(wo, profile).segs;
  return `<div class="ichart ${tall ? 'tall' : ''}" aria-hidden="true">${segs.map(s =>
    `<i class="${BANNER_CLASS[s.type] || 'walk'}" style="flex:${s.sec.toFixed(0)};height:${(Planner.INTENSITY[s.type] || 2) * 20}%"></i>`).join('')}</div>`;
}
const sameSeg = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && (a[2] || 's') === (b[2] || 's');
function groupSteps(segs) {
  const out = []; let i = 0;
  while (i < segs.length) {
    if (i + 3 < segs.length && sameSeg(segs[i], segs[i + 2]) && sameSeg(segs[i + 1], segs[i + 3])) {
      let k = 1; while (sameSeg(segs[i + 2 * k], segs[i]) && sameSeg(segs[i + 2 * k + 1], segs[i + 1])) k++;
      let reps = k, take = 2 * k;
      if (sameSeg(segs[i + take], segs[i])) { reps++; take++; } // last rep without recovery
      out.push({ reps, steps: [segs[i], segs[i + 1]] }); i += take;
    } else { out.push({ reps: 1, steps: [segs[i]] }); i++; }
  }
  return out;
}
function stepLine(s) {
  const g = { type: s[0], amt: s[1], unit: s[2] || 's' };
  const tgt = g.type !== 'recover' && paceRange(g.type);
  return `<div class="step"><i class="${BANNER_CLASS[g.type] || 'walk'}"></i><div><b>${SEG_NAME[g.type]} · ${amountShort(g)}</b>
    <small>${tgt ? 'Target ' + tgt : escapeHtml(Planner.EFFORT[g.type] || 'easy')}</small></div></div>`;
}
function stepsList(wo) {
  return groupSteps(wo.segments).map(gr => gr.reps > 1
    ? `<div class="step-group"><div class="reps">${gr.reps} ×</div>${gr.steps.map(stepLine).join('')}</div>`
    : stepLine(gr.steps[0])).join('');
}
function allWorkouts() { const b = currentPlan(); return b ? b.weeks.flatMap(w => w.workouts) : []; }
function findWorkout(key) { return allWorkouts().find(w => w.key === key); }

/* ---------- Workout detail sheet ---------- */
function openWorkout(key) {
  const wo = findWorkout(key); if (!wo) return;
  const st = planDone[key], done = st && st !== 'skip', skipped = st === 'skip';
  const run = done ? runs.find(r => r.id === st) : null;
  let moveHtml = '';
  if (!done && wo.date) {
    const mon = Planner.mondayOf(new Date(wo.date + 'T12:00')), t = todayStr();
    moveHtml = `<div class="q">Move to another day</div><div class="chips">${[0, 1, 2, 3, 4, 5, 6].map(i => {
      const d = Planner.addDays(mon, i);
      return `<label class="chip"><input type="radio" name="moveDay" value="${d}" ${d === wo.date ? 'checked' : ''} ${d < t ? 'disabled' : ''}><span>${Planner.DAY_NAMES[i]}</span></label>`;
    }).join('')}</div>`;
  }
  $('woBody').innerHTML = `
    <div class="sheet-head"><span class="kind ${KIND_CLASS[wo.kind] || 'easy'}">${KIND_LABEL[wo.kind] || 'Run'}</span>
      <span class="muted small">${wo.date ? shortDate(wo.date) : ''}</span></div>
    <h2>${escapeHtml(wo.title)}</h2>
    <p class="muted small">${woEstimate(wo)}</p>
    ${intensityChart(wo, true)}
    <p class="muted">${escapeHtml(wo.desc)}</p>
    <div class="steps-list">${stepsList(wo)}</div>
    ${run ? `<div class="done-box">✓ Completed: ${fmtDist(run.distM)} ${unitShort()} in ${fmtTime(run.dur)}${run.steps ? ` · ${scoreText(run.steps)}` : ''}</div>` : ''}
    ${skipped ? '<div class="done-box muted">Skipped</div>' : ''}
    ${moveHtml}
    <div class="btn-row">
      <button class="btn ghost" type="button" id="woClose">Close</button>
      ${done ? '' : `<button class="btn ghost" type="button" id="woSkip">${skipped ? 'Unskip' : 'Skip'}</button>`}
      ${done || skipped ? '' : '<button class="btn primary" type="button" id="woStart">Start</button>'}
    </div>`;
  $('woClose').onclick = () => $('woDlg').close();
  const sk = $('woSkip'); if (sk) sk.onclick = () => {
    if (skipped) delete planDone[key]; else planDone[key] = 'skip';
    savePlan(); $('woDlg').close(); refreshPlanViews(); toast(skipped ? 'Workout restored' : 'Workout skipped');
  };
  const sb = $('woStart'); if (sb) sb.onclick = () => { $('woDlg').close(); if (session) return toast('Finish your current run first'); startRun(wo); };
  $('woBody').querySelectorAll('input[name=moveDay]').forEach(inp => inp.onchange = () => {
    adapt.moves = adapt.moves || {}; adapt.moves[key] = inp.value; savePlan(); refreshPlanViews();
    toast(`Moved to ${shortDate(inp.value)}`); openWorkout(key);
  });
  if (!$('woDlg').open) $('woDlg').showModal();
}
function refreshPlanViews() { renderHome(); if ($('view-plan').classList.contains('active')) renderPlan(); updatePlanButton(); }

/* ---------- Home: this week ---------- */
let homeSel = null;
function renderHome() {
  const el = $('homePanel'); if (!el) return;
  if (session) { el.innerHTML = ''; return; }
  if (!profile) {
    el.innerHTML = `<div class="card hero-card"><div class="eyebrow">Get started</div><h2>Train with a plan made for you</h2>
      <p class="muted">Pick a goal, tell Stride where your fitness is now, and get guided workouts with target paces and voice coaching that adapt as you go.</p></div>`;
    return;
  }
  const b = currentPlan(), t = todayStr();
  const mon = Planner.mondayOf(new Date()), days = [0, 1, 2, 3, 4, 5, 6].map(i => Planner.addDays(mon, i));
  const byDay = {}; b.weeks.flatMap(w => w.workouts).forEach(wo => { if (wo.date && days.includes(wo.date)) (byDay[wo.date] = byDay[wo.date] || []).push(wo); });
  if (!homeSel || !days.includes(homeSel)) homeSel = t;

  const strip = days.map((d, i) => {
    const wos = byDay[d] || [], wo = wos[0];
    const st = wo && planDone[wo.key];
    const cls = ['day-pill', d === t ? 'today' : '', d === homeSel ? 'sel' : '', wo ? 'has' : ''].join(' ');
    const mark = !wo ? '' : st === 'skip' ? '<em class="skip">–</em>' : st ? '<em class="ok">✓</em>' : `<em class="dot ${KIND_CLASS[wo.kind] || 'easy'}"></em>`;
    return `<button class="${cls}" data-day="${d}"><span>${Planner.DAY_NAMES[i][0]}</span><b>${+d.slice(8)}</b>${mark}</button>`;
  }).join('');

  // Week totals
  const weekWos = Object.values(byDay).flat();
  const plannedM = weekWos.reduce((a, wo) => a + Planner.summary(wo, profile).m, 0);
  const doneM = runs.filter(r => Planner.ymd(new Date(r.date)) >= mon).reduce((a, r) => a + r.distM, 0);
  const doneN = weekWos.filter(wo => planDone[wo.key] && planDone[wo.key] !== 'skip').length;

  const sel = (byDay[homeSel] || [])[0];
  let card;
  if (sel) {
    const st = planDone[sel.key], run = st && st !== 'skip' ? runs.find(r => r.id === st) : null;
    card = `<div class="card today-card">
      <div class="sheet-head"><span class="kind ${KIND_CLASS[sel.kind] || 'easy'}">${KIND_LABEL[sel.kind] || 'Run'}</span>
        <span class="muted small">${homeSel === t ? 'Today' : shortDate(homeSel)}</span></div>
      <h2>${escapeHtml(sel.title)}</h2>
      <p class="muted small">${woEstimate(sel)}</p>
      ${intensityChart(sel)}
      ${run ? `<div class="done-box">✓ Done: ${fmtDist(run.distM)} ${unitShort()} in ${fmtTime(run.dur)}${run.steps ? ' · ' + scoreText(run.steps) : ''}</div>` : ''}
      ${st === 'skip' ? '<div class="done-box muted">Skipped</div>' : ''}
      <div class="btn-row">
        <button class="btn ghost" data-detail="${sel.key}">Details</button>
        ${st ? '' : `<button class="btn primary" data-start="${sel.key}">Start workout</button>`}
      </div></div>`;
  } else {
    const upcoming = b.weeks.flatMap(w => w.workouts).find(wo => wo.date && wo.date > homeSel && !planDone[wo.key]);
    card = `<div class="card today-card rest"><div class="eyebrow">${homeSel === t ? 'Today' : shortDate(homeSel)}</div>
      <h2>Rest day</h2><p class="muted small">Recovery is where you get fitter. A walk or gentle stretch is perfect.</p>
      ${upcoming ? `<button class="next-link" data-detail="${upcoming.key}">Next: <b>${escapeHtml(upcoming.title)}</b> · ${shortDate(upcoming.date)} ›</button>` : ''}</div>`;
  }
  const status = b.phase === 'beginner' ? `Run/walk week ${b.current + 1} of ${b.total}` : `Week ${b.current + 1} of ${b.total}`;
  el.innerHTML = `
    <div class="week-head-row"><div><div class="eyebrow">${escapeHtml(Planner.GOALS[profile.goal].label)}</div><h2>This week</h2></div>
      <span class="muted small">${status}</span></div>
    <div class="week-strip">${strip}</div>
    ${card}
    <div class="week-total"><div><b>${(doneM / unitM()).toFixed(1)}</b> / ${(plannedM / unitM()).toFixed(1)} ${unitShort()} planned</div>
      <div class="muted small">${doneN} of ${weekWos.length} workouts done</div></div>
    <div class="progress-wrap"><div class="progress" style="width:${Math.min(100, 100 * doneM / Math.max(1, plannedM))}%"></div></div>`;
}
$('homePanel').addEventListener('click', e => {
  const d = e.target.closest('[data-day]'), s = e.target.closest('[data-start]'), det = e.target.closest('[data-detail]');
  if (d) { homeSel = d.dataset.day; renderHome(); }
  if (det) openWorkout(det.dataset.detail);
  if (s) { const wo = findWorkout(s.dataset.start); if (wo) startRun(wo); }
});

/* ---------- Run analysis ---------- */
function gradeSteps(steps) {
  return (steps || []).filter(s => s.tgt && s.gps && s.m >= 100 && !s.partial).map(s => {
    const pace = s.sec / (s.m / 1000);
    const status = pace > s.tgt[1] * 1.03 ? 'slow' : pace < s.tgt[0] * 0.97 ? 'fast' : 'on';
    return { ...s, pace, status };
  });
}
function scoreText(steps) {
  const g = gradeSteps(steps); if (!g.length) return '';
  return `${g.filter(x => x.status === 'on').length}/${g.length} steps on target`;
}
function analysisHtml(steps) {
  const g = gradeSteps(steps); if (!g.length) return '';
  const k = unitM() / 1000;
  const on = g.filter(x => x.status === 'on').length;
  return `<div class="analysis"><div class="q">Workout analysis · ${on}/${g.length} on target</div>${g.map(x => `
    <div class="an-row ${x.status}"><span>${SEG_NAME[x.type]} · ${amountShort(x)}</span>
      <span><b>${fmtPace(x.pace * k)}</b> <small>vs ${fmtPace(x.tgt[0] * k)}–${fmtPace(x.tgt[1] * k)}</small></span>
      <em>${x.status === 'on' ? '✓' : x.status === 'fast' ? 'fast' : 'slow'}</em></div>`).join('')}
    <p class="muted small">${on === g.length ? 'Perfect pacing. Every step on target!' : on >= g.length / 2 ? 'Good pacing. Aim for even effort on every rep.' : 'Pacing was off target. Try starting each step more steadily.'}</p></div>`;
}

/* ---------- Run detail ---------- */
function openRunDetail(id) {
  const r = runs.find(x => x.id === id); if (!r) return;
  const pace = r.distM > 50 ? fmtPace(r.dur / (r.distM / unitM())) : '–';
  $('runBody').innerHTML = `
    <div class="eyebrow">${new Date(r.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    <h2>${r.feel ? FEEL[r.feel] + ' ' : ''}${escapeHtml(r.planTitle || (r.manual ? 'Logged run' : 'Free run'))}</h2>
    <div class="summary-grid">
      <div><b>${fmtDist(r.distM)}</b><span>${unitLong()}</span></div><div><b>${fmtTime(r.dur)}</b><span>time</span></div>
      <div><b>${pace}</b><span>avg pace /${unitShort()}</span></div><div><b>${r.splits && r.splits.length ? fmtPace(Math.min(...r.splits)) : '–'}</b><span>fastest split</span></div>
    </div>
    ${r.route && r.route.length > 1 ? '<svg id="runRoute" class="route" viewBox="0 0 300 160" style="margin-top:12px"></svg>' : ''}
    ${r.splits && r.splits.length ? `<div class="splits">${r.splits.map((s, i) => `<div><span>${unitShort()} ${i + 1}</span><span>${fmtPace(s)} /${unitShort()}</span></div>`).join('')}</div>` : ''}
    ${analysisHtml(r.steps)}
    ${r.notes ? `<p class="muted">${escapeHtml(r.notes)}</p>` : ''}`;
  if (r.route && r.route.length > 1) drawRoute($('runRoute'), r.route);
  $('runDlg').showModal();
}
$('runClose').addEventListener('click', () => $('runDlg').close());

/* ---------- Race prediction trend ---------- */
function predictionHtml() {
  if (!profile || !adapt || !(adapt.fitHist || []).length) return '';
  const goalKm = Planner.GOALS[profile.goal].dist;
  const label = { start: '5K', '5k': '5K', '10k': '10K', half: 'Half marathon', marathon: 'Marathon', fitness: '5K' }[profile.goal];
  const pts = adapt.fitHist.map(h => ({ date: h.date, t: Planner.riegel(h.t5, 5, goalKm) }));
  const cur = pts[pts.length - 1].t, first = pts[0].t, diff = Math.round(first - cur);
  let chart = '';
  if (pts.length > 1) {
    const W = 300, H = 110, pad = 14, min = Math.min(...pts.map(p => p.t)), max = Math.max(...pts.map(p => p.t)), span = Math.max(1, max - min);
    const xy = (p, i) => [pad + i * (W - 2 * pad) / (pts.length - 1), pad + (p.t - min) / span * (H - 2 * pad)]; // faster = higher
    const path = pts.map((p, i) => (i ? 'L' : 'M') + xy(p, i).map(n => n.toFixed(1)).join(' ')).join('');
    const [lx, ly] = xy(pts[pts.length - 1], pts.length - 1);
    chart = `<svg viewBox="0 0 ${W} ${H}" class="chart"><path d="${path}" fill="none" stroke="#ff5a36" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${lx}" cy="${ly}" r="5" fill="#ff5a36"/>
      <text x="${pad}" y="${H - 2}" fill="#9aa0ab" font-size="10">${shortDate(pts[0].date)}</text>
      <text x="${W - pad}" y="${H - 2}" text-anchor="end" fill="#9aa0ab" font-size="10">now</text></svg>`;
  }
  return `<div class="card"><div class="eyebrow">Race prediction</div>
    <div class="pred"><b>${Planner.mmss(cur)}</b><span>${label}</span></div>
    <p class="muted small">${diff > 0 ? `${Planner.mmss(diff)} faster since you started 🚀` : 'Updates automatically as your runs show improvement.'}</p>${chart}</div>`;
}

/* ---------- Boot ---------- */
loadSettingsUi();
if (profile) {
  const brk = Planner.checkBreak(profile, adapt, runs, planDone);
  if (brk) { savePlan(); setTimeout(() => toast(brk, 6000), 800); }
}
updatePlanButton();
renderHome();
drawRoute($('routeSvg'), []);

// Recover a run interrupted by the phone closing the tab
const saved = LS.get('active', null);
if (saved && saved.startedAt) {
  if (!saved.paused) { saved.accMs += Math.max(0, (saved.savedAt || saved.resumedAt) - saved.resumedAt); saved.paused = true; }
  ask('You have an unfinished run. Continue it?', 'Continue run', 'Save it as is').then(cont => { if (cont) {
    session = saved; session.last = null;
    startGps(); tickTimer = setInterval(tick, 500);
    $('controlsIdle').classList.add('hidden'); $('controlsActive').classList.remove('hidden'); $('liveStats').classList.remove('hidden'); renderHome();
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
