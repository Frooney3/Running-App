'use strict';
/*
 * Stride adaptive planner.
 *
 * Builds a personal training plan from a profile (goal, current fitness,
 * schedule, optional race date) and adapts it from how runs actually go:
 *  - how each plan workout felt (1–5) and whether it was finished
 *  - breaks in training
 *  - fitness improvements seen in logged runs
 *
 * Two phases:
 *  - beginner: run/walk progression (the 9-week PLAN in plan.js), advanced
 *    week by week; tough weeks are repeated, easy ones can be skipped ahead.
 *  - runner: calendar-based weeks to a goal/race date with easy, quality and
 *    long runs, cut-back weeks and a taper. A load factor scales upcoming work.
 *
 * Pure logic, no DOM. Works in the browser (window.Planner) and in Node.
 */
(function (root) {
  const PLAN = root.PLAN;

  /* ---------- small date helpers (local dates as YYYY-MM-DD) ---------- */
  const DAY = 864e5;
  const ymd = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const mondayOf = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const repeat = (n, seq) => Array.from({ length: n }, () => seq).flat();
  const mmss = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };
  const minTxt = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'min' : ''}` : `${m} min`;

  const GOALS = {
    start:    { label: 'Start running (0 → 5K)', dist: 5,      peak: 40,  taper: 0, weeks: 8 },
    '5k':     { label: 'Run a faster 5K',        dist: 5,      peak: 50,  taper: 1, weeks: 8 },
    '10k':    { label: 'Run a 10K',              dist: 10,     peak: 75,  taper: 1, weeks: 10 },
    half:     { label: 'Half marathon',          dist: 21.0975, peak: 120, taper: 2, weeks: 12 },
    marathon: { label: 'Marathon',               dist: 42.195, peak: 180, taper: 3, weeks: 16 },
    fitness:  { label: 'Stay fit & healthy',     dist: 5,      peak: 60,  taper: 0, weeks: 8 }
  };
  const RACE_LABEL = { start: '5K', '5k': '5K', '10k': '10K', half: 'half marathon', marathon: 'marathon' };
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /* ---------- profile ---------- */
  // answers: { goal, continuous (min), weeklyKm, recent: {distKm, sec}|null, days, prefDays:[0..6], raceDate|null }
  function createProfile(answers, today = new Date(), prev = null) {
    const g = GOALS[answers.goal];
    const beginner = answers.goal === 'start' || answers.continuous < 20;
    const p = {
      id: 'p' + Date.now().toString(36),
      created: ymd(today),
      goal: answers.goal,
      continuous: answers.continuous,
      weeklyKm: answers.weeklyKm || 0,
      recent: answers.recent || (prev && prev.recent) || null,
      days: answers.days,
      prefDays: [...answers.prefDays].sort((a, b) => a - b),
      raceDate: answers.raceDate || null,
      phase: beginner ? 'beginner' : 'runner',
      start: mondayOf(today),
      block: 0
    };
    p.L0 = clamp(Math.round(p.continuous), 20, g.peak);
    const easyMinPerKm = paces(p) ? paces(p).easy[0] / 60 : 6.5;
    p.weeklyMin = p.weeklyKm > 0 ? p.weeklyKm * easyMinPerKm : p.continuous * p.days * 0.8;
    return p;
  }

  function freshAdapt(prevAdapt, profile, planDone) {
    const a = { load: 1, log: (prevAdapt && prevAdapt.log) || [], struggles: 0, breakFor: prevAdapt ? prevAdapt.breakFor : null, bWeek: 1,
      moves: {}, fitHist: (prevAdapt && prevAdapt.fitHist) || [] };
    const t5 = fiveK(profile);
    if (t5 && !a.fitHist.some(h => Math.round(h.t5) === Math.round(t5))) a.fitHist.push({ date: ymd(new Date()), t5: Math.round(t5) });
    if (profile.phase === 'beginner') {
      // Keep existing run/walk progress
      const startWeek = profile.continuous >= 10 ? 5 : profile.continuous >= 3 ? 3 : 1;
      let firstOpen = 1;
      for (const wk of PLAN) { if (beginnerKeys(wk.week, profile).every(k => planDone[k])) firstOpen = wk.week + 1; else break; }
      a.bWeek = Math.max(startWeek, firstOpen);
    }
    return a;
  }

  /* ---------- fitness & paces ---------- */
  const riegel = (sec, fromKm, toKm) => sec * Math.pow(toKm / fromKm, 1.06);
  function fiveK(profile) { return profile.recent ? riegel(profile.recent.sec, profile.recent.distKm, 5) : null; }

  // seconds per km for each effort; ranges are [fast, slow]
  function paces(profile) {
    const t5 = fiveK(profile); if (!t5) return null;
    const p5 = t5 / 5, D = GOALS[profile.goal].dist;
    const racePace = riegel(t5, 5, D) / D;
    return {
      easy: [p5 * 1.18, p5 * 1.32], long: [p5 * 1.2, p5 * 1.35], recover: [p5 * 1.4, p5 * 1.7],
      tempo: [p5 * 1.06, p5 * 1.1],
      fast: profile.goal === '10k' || profile.goal === 'half' ? [p5 * 1.0, p5 * 1.04] : [p5 * 0.96, p5 * 1.0],
      steady: [racePace * 0.99, racePace * 1.02],
      race: [racePace * 0.98, racePace * 1.02]
    };
  }
  const EFFORT = {
    easy: 'conversational: you could chat in full sentences', long: 'relaxed and steady, slower than you think',
    tempo: 'comfortably hard: a few words at a time', fast: 'hard but controlled, the same pace every rep',
    steady: 'your goal race effort', recover: 'very slow jog or walk', race: 'race effort, start steady',
    run: 'slow and steady', walk: 'brisk walk'
  };
  function predictedRace(profile) {
    const t5 = fiveK(profile); const D = GOALS[profile.goal].dist;
    return t5 ? riegel(t5, 5, D) : null;
  }

  /* ---------- beginner phase ---------- */
  function beginnerIdx(profile) { return Math.min(3, profile.days) >= 3 ? [0, 1, 2] : [0, 2]; }
  function beginnerKeys(week, profile) { return beginnerIdx(profile).map(i => `w${week}d${i + 1}`); }

  function buildBeginner(profile, adapt, planDone) {
    const idx = beginnerIdx(profile);
    const weeks = PLAN.map(wk => ({
      number: wk.week, label: `Run/walk week ${wk.week}`, tip: wk.tip,
      workouts: idx.map((i, n) => {
        const segs = wk.workouts[i];
        const runs = segs.filter(s => s[0] === 'run'), run = runs.reduce((a, s) => a + s[1], 0);
        const total = segs.reduce((a, s) => a + s[1], 0);
        const title = runs.length === 1 ? `Run ${Math.round(run / 60)} min non-stop` : `Run/walk · ${runs.length} runs`;
        return {
          key: `w${wk.week}d${i + 1}`, kind: 'runwalk', title, segments: segs,
          desc: `${Math.round(total / 60)} min total, ${Math.round(run / 60)} min running. Run slowly: ${EFFORT.run}.`,
          short: `W${wk.week} D${n + 1}`
        };
      })
    }));
    const cur = Math.min(adapt.bWeek, PLAN.length);
    const graduated = adapt.bWeek > PLAN.length;
    // Suggested dates for the current week: upcoming preferred days from today
    if (!graduated) {
      const todayS = ymd(new Date()), pref = assignDays(profile.prefDays, idx.length);
      let cand = [];
      for (let i = 0; i < 14 && cand.length < 7; i++) { const d = addDays(todayS, i); if (pref.includes((parse(d).getDay() + 6) % 7)) cand.push(d); }
      weeks[cur - 1].workouts.forEach(w => { if (!planDone[w.key]) w.date = cand.shift() || todayS; });
      applyMoves(weeks[cur - 1].workouts, adapt);
    }
    const next = graduated ? null : weeks[cur - 1].workouts.find(w => !planDone[w.key]) || null;
    return { phase: 'beginner', weeks, current: cur - 1, total: weeks.length, next, graduated };
  }

  /* ---------- runner phase ---------- */
  function runnerWeeks(profile) {
    const g = GOALS[profile.goal];
    if (profile.raceDate) return clamp(Math.floor(daysBetween(profile.start, profile.raceDate) / 7) + 1, 3, 24);
    return g.weeks;
  }

  function buildRunner(profile, adapt, planDone, today = new Date()) {
    const g = GOALS[profile.goal], N = runnerWeeks(profile);
    const taper = profile.raceDate ? (N < 8 ? Math.min(g.taper, 1) : g.taper) : 0;
    const build = Math.max(1, N - taper);
    const pace = paces(profile);
    const load = adapt.load;
    const mid = t => pace && pace[t] ? (pace[t][0] + pace[t][1]) / 2 : null;
    // minutes at a given effort -> km rounded to 0.5 (only when paces are known)
    const toKm = (min, t, lo = 1) => Math.max(lo, Math.round(min * 60 / mid(t) * 2) / 2);

    const longBase = [];
    for (let w = 0; w < build; w++) {
      const lin = profile.L0 + (g.peak - profile.L0) * w / Math.max(1, build - 1);
      let v = Math.min(lin, profile.L0 * Math.pow(1.1, w));
      if (w % 4 === 3 && w < build - 1) v *= 0.8; // cut-back week
      longBase.push(v);
    }
    const lastBuild = longBase[build - 1];
    for (let t = 0; t < taper; t++) longBase.push(lastBuild * (0.7 - 0.12 * t));

    // Ease in so week 1 is close to what you do now
    const raw0 = longBase[0] + (profile.days - 1) * clamp(0.55 * longBase[0], 20, 60);
    const target0 = Math.max(profile.weeklyMin * 1.1, 60);
    const s0 = clamp(target0 / raw0, 0.6, 1);
    const ramp = w => w >= 4 ? 1 : s0 + (1 - s0) * w / 4;

    const order = {
      2: ['quality', 'long'], 3: ['easy', 'quality', 'long'], 4: ['easy', 'quality', 'easy', 'long'],
      5: ['easy', 'quality', 'easy', 'easy', 'long'], 6: ['easy', 'quality', 'easy', 'easy', 'easy', 'long']
    }[profile.days];

    const weeks = [];
    for (let w = 0; w < N; w++) {
      const weekStart = addDays(profile.start, 7 * w);
      const raceWeek = !!profile.raceDate && w === N - 1;
      const taperWeek = w >= build;
      const f = load * ramp(w);
      const L = Math.max(15, Math.round(longBase[w] * f));
      const E = Math.round(clamp(0.55 * longBase[w], 20, 60) * f * (taperWeek ? 0.8 : 1));
      let qType;
      if (profile.goal === 'half' || profile.goal === 'marathon') qType = w % 2 ? 'steady' : 'tempo';
      else if (profile.goal === 'fitness' || profile.goal === 'start') qType = w % 2 ? 'tempo' : 'fartlek';
      else qType = w % 2 ? 'tempo' : 'intervals';

      const list = order.map((kind, i) => {
        if (raceWeek && kind === 'long') return raceWorkout(profile);
        if (raceWeek && kind === 'quality') return sharpener();
        if (raceWeek) return easyRun(20, 'Short and easy. Save your legs for race day.');
        if (kind === 'long') return longRun(L);
        if (kind === 'easy') return easyRun(Math.max(15, i === 4 ? Math.round(E * 0.7) : E));
        return quality(qType, w, f * (taperWeek ? 0.8 : 1), profile);
      });

      // Suggested days
      const days = assignDays(profile.prefDays, list.length);
      list.forEach((wo, i) => {
        wo.key = `${profile.id}:${profile.block}:${w}:${i}`;
        wo.date = raceWeek && wo.kind === 'race' ? profile.raceDate : addDays(weekStart, days[i]);
        wo.short = `Wk ${w + 1}`;
      });
      let wl = list;
      if (w === 0) { // first week starts part-way: skip sessions whose day has already passed
        wl = list.filter(wo => wo.date >= profile.created);
        if (!wl.length) { const e = easyRun(Math.min(E, 30)); e.key = `${profile.id}:${profile.block}:0:x`; e.date = profile.created; e.short = 'Wk 1'; wl = [e]; }
      }
      if (raceWeek) { // keep other runs before race day
        list.forEach(wo => { if (wo.kind !== 'race' && wo.date >= profile.raceDate) wo.date = addDays(profile.raceDate, -2); });
      }
      applyMoves(wl, adapt);
      const tags = [];
      if (w % 4 === 3 && w < build - 1) tags.push('Cut-back week: a little lighter so your body can absorb the training.');
      if (taperWeek && !raceWeek) tags.push('Taper: less running so you arrive fresh.');
      if (raceWeek) tags.push(`Race week. Your ${RACE_LABEL[profile.goal] || 'race'} is on ${parse(profile.raceDate).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}.`);
      weeks.push({ number: w + 1, start: weekStart, label: `Week ${w + 1}`, tip: tags.join(' ') || weekTip(w, build), workouts: wl });
    }

    const todayS = ymd(today);
    const rawIdx = Math.floor(daysBetween(profile.start, mondayOf(today)) / 7);
    const current = clamp(rawIdx, 0, N - 1);
    const finished = rawIdx >= N || (profile.raceDate && todayS > profile.raceDate);
    const next = finished ? null : (weeks[current].workouts.find(w => !planDone[w.key]) || null);
    return { phase: 'runner', weeks, current, total: N, next, finished, pace };

    /* builders */
    function easyRun(m, extra) {
      const desc = extra || `Keep it ${EFFORT.easy}. Easy running builds your engine.`;
      if (pace) { const km = toKm(m, 'easy', 2); return { kind: 'easy', title: `Easy run · ${km} km`, segments: [['easy', km * 1000, 'm']], desc }; }
      return { kind: 'easy', title: `Easy run · ${minTxt(m)}`, segments: [['easy', m * 60]], desc };
    }
    function longRun(m) {
      const desc = `Your key run of the week. Keep it ${EFFORT.long}. Walk breaks are fine.`;
      if (pace) { const km = toKm(m, 'long', 3); return { kind: 'long', title: `Long run · ${km} km`, segments: [['long', km * 1000, 'm']], desc }; }
      return { kind: 'long', title: `Long run · ${minTxt(m)}`, segments: [['long', m * 60]], desc };
    }
    function sharpener() {
      return { kind: 'sharpener', title: 'Race-week sharpener', desc: 'Short, with a few strides at race pace to stay sharp.',
        segments: [['jogwarm', 600], ...repeat(4, [['race', 60], ['easy', 120]]), ['jogcool', 300]] };
    }
    function raceWorkout(p) {
      const pred = predictedRace(p);
      const raceSec = Math.round(pred || g.dist * 7 * 60);
      return { kind: 'race', title: `Race day: ${RACE_LABEL[p.goal] || 'goal run'}!`,
        desc: pred ? `Predicted finish around ${mmss(pred)}. Start steady and finish strong.` : 'Start steady, enjoy it, finish strong.',
        segments: [['jogwarm', 600], ['race', Math.round(g.dist * 1000), 'm'], ['jogcool', 300]], estRace: raceSec };
    }
    function quality(type, w, f, p) {
      if (type === 'tempo') {
        const T = Math.round(clamp(10 + w * 1.5, 10, p.goal === '5k' || p.goal === 'fitness' || p.goal === 'start' ? 20 : 30) * f);
        const desc = `After a warm-up, hold a ${EFFORT.tempo} pace.`;
        if (pace) { const km = toKm(Math.max(5, T), 'tempo', 1.5); return { kind: 'tempo', title: `Tempo · ${km} km`, desc, segments: [['jogwarm', 600], ['tempo', km * 1000, 'm'], ['jogcool', 600]] }; }
        return { kind: 'tempo', title: `Tempo run · ${T} min tempo`, desc,
          segments: [['jogwarm', 600], ['tempo', Math.max(5, T) * 60], ['jogcool', 600]] };
      }
      if (type === 'intervals') {
        const n = Math.max(3, Math.round(clamp(4 + Math.floor(w / 2), 4, 8) * f));
        const rep = p.goal === '10k' ? 240 : 180;
        if (pace) {
          const repM = p.goal === '10k' || p.goal === 'half' ? 1000 : 800, rec = repM === 800 ? 90 : 120;
          const core = repeat(n, [['fast', repM, 'm'], ['recover', rec]]); core.pop();
          return { kind: 'intervals', title: `Intervals · ${n} × ${repM} m`, desc: `Fast reps: ${EFFORT.fast}. ${rec === 120 ? '2 min' : '90 s'} easy jog between reps.`,
            segments: [['jogwarm', 600], ...core, ['jogcool', 600]] };
        }
        const core = repeat(n, [['fast', rep], ['recover', 120]]); core.pop();
        return { kind: 'intervals', title: `Intervals · ${n} × ${rep / 60} min`, desc: `Fast reps: ${EFFORT.fast}. Jog slowly in between.`,
          segments: [['jogwarm', 600], ...core, ['jogcool', 600]] };
      }
      if (type === 'steady') {
        const M = Math.round(clamp(15 + 3 * w, 15, p.goal === 'half' ? 40 : 60) * f);
        if (pace) { const km = toKm(Math.max(10, M), 'steady', 2); return { kind: 'steady', title: `Race-pace run · ${km} km`, desc: `Practise ${EFFORT.steady}. It should feel controlled.`, segments: [['jogwarm', 600], ['steady', km * 1000, 'm'], ['jogcool', 600]] }; }
        return { kind: 'steady', title: `Race-pace run · ${M} min`, desc: `Practise ${EFFORT.steady}. It should feel controlled.`,
          segments: [['jogwarm', 600], ['steady', Math.max(10, M) * 60], ['jogcool', 600]] };
      }
      const n = Math.max(4, Math.round(clamp(6 + Math.floor(w / 2), 6, 10) * f));
      const core = repeat(n, [['fast', 60], ['easy', 120]]); core.pop();
      return { kind: 'fartlek', title: `Fartlek · ${n} × 1 min faster`, desc: 'Playful speed: 1 minute quicker, 2 minutes easy.',
        segments: [['jogwarm', 600], ...core, ['jogcool', 300]] };
    }
  }

  function applyMoves(list, adapt) {
    const mv = adapt.moves || {};
    list.forEach(wo => { if (mv[wo.key]) wo.date = mv[wo.key]; });
    list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  /* ---------- workout estimates ---------- */
  const DEFAULT_PACE = { easy: 420, long: 430, recover: 540, tempo: 360, fast: 330, steady: 380, race: 360, run: 450,
    walk: 720, warmup: 720, cooldown: 720, jogwarm: 440, jogcool: 450 };
  const INTENSITY = { walk: 1, warmup: 1, cooldown: 1, recover: 1, jogwarm: 2, jogcool: 2, easy: 2, long: 2, run: 2, steady: 3, tempo: 4, fast: 5, race: 5 };
  function paceFor(type, profile) {
    const p = profile && paces(profile);
    return p && p[type] ? (p[type][0] + p[type][1]) / 2 : DEFAULT_PACE[type] || 450;
  }
  // [type, amount, unit] -> {type, amt, unit, sec, m}
  function seg(s, profile) {
    const type = s[0], unit = s[2] || 's', amt = s[1], pk = paceFor(type, profile);
    return unit === 'm' ? { type, amt, unit, m: amt, sec: amt / 1000 * pk } : { type, amt, unit, sec: amt, m: amt / pk * 1000 };
  }
  function summary(wo, profile) {
    const segs = wo.segments.map(s => seg(s, profile));
    return { sec: segs.reduce((a, s) => a + s.sec, 0), m: segs.reduce((a, s) => a + s.m, 0), segs };
  }

  function weekTip(w, build) {
    if (w === 0) return 'Welcome to your plan. Start gently: the first weeks ease you in.';
    if (w === build - 1) return 'Peak week: your biggest week. Sleep and eat well.';
    return ['Most running should feel easy. Speed comes from consistency.',
      'Keep rest days between hard sessions.',
      'Hydrate well and keep up your sleep. That is where you get fitter.',
      'If something hurts sharply, rest. Missing one run is better than missing ten.'][w % 4];
  }

  // Spread n workouts over the preferred days (0=Mon..6=Sun). Long run goes on the last day.
  function assignDays(pref, n) {
    let days = [...pref].sort((a, b) => a - b);
    if (days.length < n) { // fill gaps if fewer preferred days than runs
      const all = [0, 1, 2, 3, 4, 5, 6].filter(d => !days.includes(d));
      while (days.length < n) days.push(all.shift());
      days.sort((a, b) => a - b);
    }
    if (days.length > n) { // pick evenly spaced
      const out = []; for (let i = 0; i < n; i++) out.push(days[Math.round(i * (days.length - 1) / Math.max(1, n - 1))]);
      days = [...new Set(out)];
    }
    return days;
  }

  /* ---------- public: build ---------- */
  function build(profile, adapt, planDone, today = new Date()) {
    if (!profile) return null;
    // Rolling blocks for open-ended fitness goals
    if (profile.phase === 'runner' && !profile.raceDate) {
      const N = runnerWeeks(profile);
      while (Math.floor(daysBetween(profile.start, mondayOf(today)) / 7) >= N) {
        profile.start = addDays(profile.start, 7 * N); profile.block++;
        profile.L0 = Math.round(GOALS[profile.goal].peak * 0.8);
      }
    }
    return profile.phase === 'beginner' ? buildBeginner(profile, adapt, planDone) : buildRunner(profile, adapt, planDone, today);
  }

  /* ---------- public: adaptation ---------- */
  function log(adapt, msg, today) {
    adapt.log.unshift({ date: ymd(today), msg });
    adapt.log = adapt.log.slice(0, 20);
    return msg;
  }

  // Called after a plan workout has been saved. Returns user-facing messages.
  function afterRun(profile, adapt, run, planDone, runs, today = new Date()) {
    const msgs = [];
    if (!profile || !run.plan) return msgs;
    const feel = run.feel || 3, done = run.planComplete;
    const struggled = !done || feel <= 2;
    adapt.struggles = struggled ? (adapt.struggles || 0) + 1 : 0;

    if (profile.phase === 'beginner') {
      const m = /^w(\d+)d(\d+)$/.exec(run.plan);
      if (!m) return msgs;
      const wk = +m[1];
      if (!done) msgs.push(log(adapt, `Stopped early on week ${wk}. That's fine: repeat this workout next time.`, today));
      if (done && wk === adapt.bWeek) {
        const keys = beginnerKeys(wk, profile);
        if (keys.every(k => planDone[k])) {
          const feels = keys.map(k => (runs.find(r => r.id === planDone[k]) || {}).feel).filter(Boolean);
          const avg = feels.length ? feels.reduce((a, b) => a + b, 0) / feels.length : 3;
          if (avg <= 2) {
            keys.forEach(k => delete planDone[k]);
            msgs.push(log(adapt, `Week ${wk} felt tough, so we'll repeat it. No rush: it'll feel easier second time.`, today));
          } else if (feels.length === keys.length && feels.every(f => f === 5) && wk + 2 <= PLAN.length && wk !== 4) {
            adapt.bWeek = wk + 2;
            msgs.push(log(adapt, `You smashed week ${wk}! Skipping ahead to week ${wk + 2}.`, today));
          } else {
            adapt.bWeek = wk + 1;
            msgs.push(log(adapt, wk + 1 <= PLAN.length ? `Week ${wk} complete! On to week ${wk + 1}.` : 'Run/walk programme complete!', today));
          }
          if (adapt.bWeek > PLAN.length) {
            if (profile.goal === 'start') msgs.push(log(adapt, 'You can now run 30 minutes non-stop. You\'re a runner! Set a new goal to keep going.', today));
            else {
              profile.phase = 'runner'; profile.continuous = Math.max(profile.continuous, 30); profile.L0 = 30;
              profile.start = addDays(mondayOf(today), 7); profile.weeklyMin = 90; adapt.load = 1;
              msgs.push(log(adapt, `Run/walk phase complete! Your ${GOALS[profile.goal].label.toLowerCase()} training starts next week.`, today));
            }
          }
        }
      } else if (done && feel <= 2 && adapt.struggles >= 2) {
        msgs.push(log(adapt, 'Two tough runs in a row. Take an extra rest day before the next one.', today));
      }
      return msgs;
    }

    // Runner phase: scale upcoming work
    let factor = 1, why = '';
    if (!done || feel === 1) { factor = 0.9; why = !done ? 'You stopped early' : 'That felt really hard'; }
    else if (feel === 2) { factor = 0.95; why = 'That felt tough'; }
    else if (feel === 4) factor = 1.02;
    else if (feel === 5) { factor = 1.05; why = 'You\'re flying'; }
    const before = adapt.load;
    adapt.load = Math.round(clamp(adapt.load * factor, 0.6, 1.2) * 100) / 100;
    const pct = Math.round((adapt.load / before - 1) * 100);
    if (why && pct !== 0) msgs.push(log(adapt, `${why}, so upcoming runs are ${pct < 0 ? 'eased' : 'increased'} by ${Math.abs(pct)}%.`, today));
    if (adapt.struggles >= 2) msgs.push(log(adapt, 'Two tough sessions in a row. Take an extra rest day before the next run.', today));
    return msgs;
  }

  // Update fitness estimate from any run. Returns a message or null.
  function updateFitness(profile, adapt, run, today = new Date()) {
    if (!profile || !run || run.distM < 2000 || !run.dur) return null;
    const est = riegel(run.dur, run.distM / 1000, 5);
    const cur = fiveK(profile);
    if (run.dur / 60 > profile.continuous && run.planComplete !== false) profile.continuous = Math.round(run.dur / 60);
    if (cur && est >= cur * 0.98) return null;
    profile.recent = { distKm: +(run.distM / 1000).toFixed(2), sec: run.dur, auto: true };
    (adapt.fitHist = adapt.fitHist || []).push({ date: ymd(today), t5: Math.round(est) });
    return log(adapt, cur ? `Fitness up! Your estimated 5K is now ${mmss(est)}. Paces updated.`
      : `Estimated your 5K at about ${mmss(est)} from this run. Target paces added.`, today);
  }

  // Detect a training break and ease the plan. Returns a message or null.
  function checkBreak(profile, adapt, runs, planDone, today = new Date()) {
    if (!profile || !runs.length) return null;
    const last = runs[0];
    const lastDay = ymd(new Date(last.date));
    if (lastDay < profile.created) return null;
    const gap = daysBetween(lastDay, ymd(today));
    if (gap < 10 || adapt.breakFor === last.id) return null;
    adapt.breakFor = last.id;
    if (profile.phase === 'beginner') {
      if (gap >= 14 && adapt.bWeek > 1) {
        adapt.bWeek = Math.min(adapt.bWeek, PLAN.length) - 1;
        beginnerKeys(adapt.bWeek, profile).forEach(k => delete planDone[k]);
        return log(adapt, `Welcome back! After ${gap} days off, we've stepped back to week ${adapt.bWeek} to rebuild.`, today);
      }
      return log(adapt, `Welcome back after ${gap} days! Take this next run nice and easy.`, today);
    }
    const f = gap >= 21 ? 0.75 : 0.85;
    adapt.load = Math.round(clamp(adapt.load * f, 0.6, 1.2) * 100) / 100;
    return log(adapt, `Welcome back! After ${gap} days off, upcoming runs are eased by ${Math.round((1 - f) * 100)}%.`, today);
  }

  // Short summary of what the plan will look like, for the setup review step.
  function preview(profile) {
    const g = GOALS[profile.goal];
    if (profile.phase === 'beginner') {
      const start = profile.continuous >= 10 ? 5 : profile.continuous >= 3 ? 3 : 1;
      const perWeek = Math.min(3, profile.days);
      const lines = [`Run/walk programme from week ${start}, ${perWeek} runs a week, building to 30 minutes non-stop.`];
      if (profile.days > 3) lines.push('Beginners do best with 3 runs a week. On your other days, walk or cross-train.');
      if (profile.goal !== 'start') lines.push(`Then it moves straight into ${g.label.toLowerCase()} training.`);
      return lines;
    }
    const N = runnerWeeks(profile);
    const lines = [`${N} weeks, ${profile.days} runs a week (${assignDays(profile.prefDays, profile.days).map(d => DAY_NAMES[d]).join(', ')}).`,
      `Long run builds from about ${minTxt(Math.round(profile.L0))} to ${minTxt(g.peak)}${profile.raceDate ? ', with a taper before race day' : ''}.`];
    const pred = predictedRace(profile);
    if (pred && profile.goal !== 'fitness') lines.push(`Current predicted ${RACE_LABEL[profile.goal]} time: ${mmss(pred)}.`);
    if (profile.raceDate) {
      const wk = Math.floor(daysBetween(profile.start, profile.raceDate) / 7) + 1;
      const ideal = g.weeks;
      if (wk < Math.ceil(ideal * 0.6)) lines.push(`⚠️ Only ${wk} weeks to race day. Ideally allow ${ideal}. The plan is compressed, so listen to your body.`);
    }
    if (profile.goal === 'marathon' && profile.continuous < 45) lines.push('⚠️ A marathon is a big jump. Consider a half marathon first.');
    return lines;
  }

  root.Planner = { INTENSITY, seg, summary, paceFor, riegel, mondayOf, addDays, GOALS, DAY_NAMES, createProfile, freshAdapt, build, afterRun, updateFitness, checkBreak, preview, paces, fiveK, predictedRace, EFFORT, mmss, ymd };
  if (typeof module !== 'undefined') module.exports = root.Planner;
})(typeof window !== 'undefined' ? window : globalThis);
