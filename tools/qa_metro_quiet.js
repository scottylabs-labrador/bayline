// QA (Bayline Metro, M3.1): the metro runtime's quiet mode far from the lines (46_metrosim.js). Injected with
// tools/shot.mjs --eval at a Peninsula station far from any metro track (e.g. #auto&t=08:05&at=palo_alto):
// 1. far away: MetroSim.quiet, nothing batched or posed, the trains' list still refreshed (positions move);
// 2. on a metro platform (MetroPlay.teleport): the quiet mode ends at once and a consist is posed when a train is near;
// 3. back at the Peninsula station: quiet again, every consist and the far batch hidden; the metro still on.
new Promise(r => { const f = () => window.__bayline && __bayline.MetroSim && __bayline.MetroSim.ready ? r() : setTimeout(f, 300); f(); }).then(async () => {
  const B = __bayline, S = B.MetroSim, P = B.Player, sleep = (ms) => new Promise(r => setTimeout(r, ms)), steps = [];
  const step = (s, ok, x) => steps.push({ s, ok: !!ok, ...(x || {}) });
  const cam = () => B.Env.camera.position, pa = B.Stations.list.find(s => s.id === 'palo_alto');
  await sleep(4000);
  const p0 = S.running.map(t => [t.key, t.x, t.z]); await sleep(2500);
  const moved = S.running.filter(t => { const o = p0.find(q => q[0] === t.key); return o && Math.hypot(t.x - o[1], t.z - o[2]) > 1; }).length;
  step('far: quiet, nothing batched or posed, the train list still refreshed', S.quiet && S.stats.consists === 0 && S.stats.far === 0 && S.running.length > 10 && moved > 5,
    { quiet: S.quiet, running: S.running.length, moved, consists: S.stats.consists, far: S.stats.far, ms: +S.stats.ms.toFixed(3) });
  B.MetroPlay.teleport('MLBR'); await sleep(1200);
  step('on the Millbrae metro platform: not quiet', !S.quiet, { quiet: S.quiet, y: +P.walk.y.toFixed(1) });
  B.Env.time.scale = 4; let posed = 0;
  for (let i = 0; i < 90 && !posed; i++) { await sleep(500); posed = S.stats.consists; }
  B.Env.time.scale = 1;
  step('a train near the platform is posed', posed > 0, { consists: posed, far: S.stats.far });
  if (P.teleportToStation) P.teleportToStation(pa, 1); await sleep(2500);
  step('back at Palo Alto: quiet again, consists and far batch hidden', S.quiet && S.stats.consists === 0 && S.stats.far === 0 && B.Metro.on,
    { quiet: S.quiet, consists: S.stats.consists, far: S.stats.far, cam: [Math.round(cam().x), Math.round(cam().z)] });
  const ok = steps.every(x => x.ok) && B.Metro.on;
  return JSON.stringify({ ok, steps });
});
