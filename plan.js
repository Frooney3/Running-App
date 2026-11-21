// Couch-to-5K style plan: 9 weeks, 3 workouts per week.
// Each workout is a list of [type, seconds]. Every workout starts with a
// 5-minute warm-up walk and ends with a 5-minute cool-down walk.
const M = 60;
const repeat = (n, seq) => Array.from({ length: n }, () => seq).flat();
const wrap = core => [['warmup', 5 * M], ...core, ['cooldown', 5 * M]];

const W1 = wrap(repeat(8, [['run', 60], ['walk', 90]]));
const W2 = wrap(repeat(6, [['run', 90], ['walk', 120]]));
const W3 = wrap(repeat(2, [['run', 90], ['walk', 90], ['run', 3 * M], ['walk', 3 * M]]));
const W4 = wrap([['run', 3 * M], ['walk', 90], ['run', 5 * M], ['walk', 150], ['run', 3 * M], ['walk', 90], ['run', 5 * M]]);

window.PLAN = [
  { week: 1, workouts: [W1, W1, W1], tip: 'Easy does it. Run slowly enough that you could still talk.' },
  { week: 2, workouts: [W2, W2, W2], tip: 'Slightly longer runs. Keep the walk breaks relaxed.' },
  { week: 3, workouts: [W3, W3, W3], tip: 'Your first 3-minute runs. Short strides, steady breathing.' },
  { week: 4, workouts: [W4, W4, W4], tip: 'Five-minute runs! Slow down if you need to, but keep moving.' },
  { week: 5, workouts: [
      wrap(repeat(3, [['run', 5 * M], ['walk', 3 * M]])),
      wrap([['run', 8 * M], ['walk', 5 * M], ['run', 8 * M]]),
      wrap([['run', 20 * M]])
    ], tip: 'A big week: it ends with 20 minutes non-stop. You are ready for it.' },
  { week: 6, workouts: [
      wrap([['run', 5 * M], ['walk', 3 * M], ['run', 8 * M], ['walk', 3 * M], ['run', 5 * M]]),
      wrap([['run', 10 * M], ['walk', 3 * M], ['run', 10 * M]]),
      wrap([['run', 25 * M]])
    ], tip: 'Building endurance. Pace yourself: slow is fine.' },
  { week: 7, workouts: [wrap([['run', 25 * M]]), wrap([['run', 25 * M]]), wrap([['run', 25 * M]])], tip: '25 minutes, three times. Find your rhythm.' },
  { week: 8, workouts: [wrap([['run', 28 * M]]), wrap([['run', 28 * M]]), wrap([['run', 28 * M]])], tip: 'Nearly there. Trust your training.' },
  { week: 9, workouts: [wrap([['run', 30 * M]]), wrap([['run', 30 * M]]), wrap([['run', 30 * M]])], tip: 'Graduation week: 30 minutes of running. You are a runner!' }
];
