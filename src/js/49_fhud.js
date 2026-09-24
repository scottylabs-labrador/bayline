// FHud: everything you see around the aircraft. A glass-cockpit primary flight display (attitude with pitch ladder,
// bank scale, flight path vector and ILS deviation, speed tape with trend / bugs / stall and overspeed bands,
// altitude tape with the radio altimeter, vertical speed, heading tape), flight mode annunciators, engine and
// configuration displays, warnings; a conformal green HUD in the cockpit view; the live instrument panel in the
// cockpit (two PFDs, a navigation display with nearby airports and runways, engine gauges; round gauges in the
// Cessna); the setup screen (aircraft, airport search, runway, start, time, assists), the pause menu, the crash
// card and touch controls.
const FHud = (() => {
  const D = Math.PI / 180, KT = 0.514444, FT = 0.3048, NM = 1852;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  let cv = null, g = null, W = 0, H = 0, dpr = 1, shown = false, root = null;
  let notes = [], trendKt = 0, lastKt = null, panelT = 0, menuEl = null, setupEl = null, crashEl = null, touchEl = null;
  const COL = { sky: '#2a6fb8', gnd: '#7a4f28', white: '#f2f2ee', green: '#3ef08a', amber: '#ffb000', red: '#ff3b30', mag: '#ff5cf0', cyan: '#43d9ff', box: 'rgba(8,10,14,.62)', line: 'rgba(255,255,255,.18)' };

  // ---------------------------------------------------------------- DOM
  const CSS = `
  #fhud{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:11}
  body.photo #fhud,body.photo #ftouch{display:none!important}
  .fov{position:fixed;inset:0;display:grid;place-items:center;z-index:25;background:rgba(5,7,10,.45)}
  .fov .card{padding:22px 24px;max-height:90vh;overflow:auto;width:min(1080px,95vw)}
  .fov h2{font-family:var(--cond);font-size:32px;margin:2px 0 10px}
  .fgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .fcard{text-align:left;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.04)}
  .fcard:hover{background:rgba(255,255,255,.09)} .fcard.on{border-color:rgba(224,64,47,.8);background:rgba(224,64,47,.14)}
  .fcard b{display:block;font-size:16px} .fcard small{color:var(--ink-dim);font-size:12.5px;line-height:1.35;display:block;margin-top:3px}
  .fcard .facts{font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin-top:6px}
  .frow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
  .frow label{color:var(--ink-faint);font-size:13px;min-width:74px}
  .fsearch{flex:1;min-width:220px;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--ink);font:inherit}
  .fres{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}
  .fres button{text-align:left;border:1px solid var(--line);background:rgba(255,255,255,.03);border-radius:9px;padding:8px 10px;font-size:13px}
  .fres button.on{border-color:rgba(224,64,47,.8);background:rgba(224,64,47,.14)} .fres button:hover{background:rgba(255,255,255,.09)}
  .fres b{font-family:var(--mono);margin-right:6px} .fres span{color:var(--ink-dim)}
  .fsel{background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:10px;padding:8px 10px;color:var(--ink);font:inherit}
  .fnote{color:var(--ink-faint);font-size:12px;margin-top:10px;line-height:1.5}
  #ftouch{position:fixed;inset:0;pointer-events:none;z-index:12}
  #ftouch .stick{position:absolute;left:22px;bottom:22px;width:150px;height:150px;border-radius:50%;background:rgba(16,19,24,.35);border:1px solid rgba(255,255,255,.2);pointer-events:auto;touch-action:none}
  #ftouch .stick i{position:absolute;left:50%;top:50%;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;background:rgba(255,255,255,.3)}
  #ftouch .thr{position:absolute;right:22px;bottom:22px;width:64px;height:190px;border-radius:14px;background:rgba(16,19,24,.35);border:1px solid rgba(255,255,255,.2);pointer-events:auto;touch-action:none}
  #ftouch .thr i{position:absolute;left:6px;right:6px;height:26px;border-radius:8px;background:rgba(255,255,255,.35)}
  #ftouch .btns{position:absolute;right:98px;bottom:22px;display:grid;grid-template-columns:repeat(2,64px);gap:8px;pointer-events:auto}
  #ftouch .btns button{border:1px solid rgba(255,255,255,.2);background:rgba(16,19,24,.45);border-radius:10px;padding:9px 0;font-size:12px;font-weight:600;touch-action:manipulation;user-select:none;-webkit-user-select:none}
  #fcu{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:12;display:flex;gap:6px;align-items:stretch;padding:6px 8px;pointer-events:auto;font-family:var(--mono);user-select:none;-webkit-user-select:none}
  #fcu .g{display:flex;flex-direction:column;align-items:center;padding:0 6px;border-left:1px solid var(--line)} #fcu .g:first-child{border-left:none}
  #fcu .l{font-size:10px;letter-spacing:.12em;color:var(--ink-faint)} #fcu .v{font-size:15px;font-weight:600;color:#ffb347;min-width:58px;text-align:center;cursor:ns-resize}
  #fcu .v.dash{color:var(--ink-faint)} #fcu .r{display:flex;align-items:center;gap:3px}
  #fcu button{border:1px solid var(--line);background:rgba(255,255,255,.06);border-radius:6px;padding:1px 7px;font-size:12px;line-height:18px;color:var(--ink)}
  #fcu button:hover{background:rgba(255,255,255,.14)} #fcu .k{font-weight:700;letter-spacing:.06em;padding:5px 9px;font-size:12px}
  #fcu .k.on{background:rgba(62,240,138,.18);border-color:rgba(62,240,138,.7);color:#8dffc0} #fcu .k.arm{border-color:rgba(67,217,255,.7);color:#9be8ff}
  body.photo #fcu{display:none!important}
  @media (max-width:1320px) and (min-width:761px){#fcu{top:74px}}
  @media (max-width:760px){#fcu{top:auto;bottom:250px;transform:translateX(-50%) scale(.82);transform-origin:bottom center} #fcu .g.hide-s{display:none}}
  @media (max-width:760px){.fgrid{grid-template-columns:1fr 1fr!important} .fres{grid-template-columns:1fr}}
  `;
  function init() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    cv = document.createElement('canvas'); cv.id = 'fhud'; cv.hidden = true; document.body.appendChild(cv); g = cv.getContext('2d');
    window.addEventListener('resize', resize); resize();
  }
  function resize() { dpr = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; if (cv) { cv.width = W * dpr; cv.height = H * dpr; } }
  function show(v) { shown = v; if (cv) cv.hidden = !v; if (!v) { menu(false); if (crashEl) crashEl.hidden = true; } touchUi(v); fcu(v); }

  // ---------------------------------------------------------------- the autopilot panel (flight control unit)
  let fcuEl = null, fcuT = 0;
  function fcu(on) {
    if (!fcuEl) {
      fcuEl = document.createElement('div'); fcuEl.id = 'fcu'; fcuEl.className = 'panel'; fcuEl.hidden = true;
      const val = (id, label, cls = '') => `<div class="g ${cls}"><span class="l">${label}</span><div class="r"><button data-d="${id}:-">−</button><span class="v" data-v="${id}">---</span><button data-d="${id}:+">+</button></div></div>`;
      fcuEl.innerHTML = `<div class="g"><span class="l">AUTOPILOT</span><div class="r"><button class="k" data-k="ap">AP</button><button class="k" data-k="athr">A/THR</button><button class="k" data-k="appr">APPR</button></div></div>`
        + val('spd', 'SPD') + val('hdg', 'HDG') + val('alt', 'ALT') + val('vs', 'V/S', 'hide-s');
      document.body.appendChild(fcuEl);
      const step = { spd: [5, 1], hdg: [5, 1], alt: [1000, 100], vs: [500, 100] };
      const adjust = (id, sign, fine) => {
        const F = Flight, A = F.fcs && F.fcs.ap, ac = F.ac; if (!A) return;
        const d = sign * step[id][fine ? 1 : 0];
        if (id === 'spd') A.spd = Math.max(40, Math.round((A.spd === null ? ac.out.cas / KT : A.spd) + d));
        if (id === 'hdg') A.hdg = ((Math.round((A.hdg === null ? F.euler.hdg / D : A.hdg / D) + d) % 360 + 360) % 360) * D;
        if (id === 'alt') A.alt = Math.max(0, Math.round(((A.alt === null ? ac.pos.y / FT : A.alt / FT) + d) / 100) * 100) * FT;
        if (id === 'vs') { const cur = A.vs === null ? 0 : A.vs / FT * 60; A.vs = Math.max(-6000, Math.min(6000, Math.round((cur + d) / 100) * 100)) * FT / 60; if (Math.abs(A.vs) < 1e-6) A.vs = 500 * FT / 60; }
        fcuT = 0;
      };
      fcuEl.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return; e.stopPropagation();
        if (b.dataset.d) { const [id, sg] = b.dataset.d.split(':'); adjust(id, sg === '+' ? 1 : -1, e.shiftKey); }
        if (b.dataset.k === 'ap') Flight.toggleAP(); if (b.dataset.k === 'athr') Flight.input.press('KeyU'); if (b.dataset.k === 'appr') Flight.armApproach();
        fcuT = 0;
      });
      fcuEl.addEventListener('wheel', (e) => { const v = e.target.closest('[data-v]'); if (!v) return; e.preventDefault(); e.stopPropagation(); adjust(v.dataset.v, e.deltaY < 0 ? 1 : -1, e.shiftKey); }, { passive: false });
      fcuEl.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    fcuEl.hidden = !on;
  }
  function fcuUpdate(F, dt) {
    if (!fcuEl || fcuEl.hidden) return; fcuT -= dt; if (fcuT > 0) return; fcuT = 0.15;
    const A = F.fcs.ap, q = (s2) => fcuEl.querySelector(s2);
    const setV = (id, t, dash) => { const e = q(`[data-v=${id}]`); e.textContent = t; e.classList.toggle('dash', !!dash); };
    setV('spd', A.spd === null ? '---' : String(A.spd), A.spd === null || !A.athr);
    setV('hdg', A.hdg === null ? '---' : String(Math.round(A.hdg / D) % 360 || 360).padStart(3, '0'), A.hdg === null || !A.on || A.appr);
    setV('alt', A.alt === null ? '-----' : String(Math.round(A.alt / FT)), A.alt === null || !A.on);
    setV('vs', A.vs === null ? '----' : (A.vs >= 0 ? '+' : '') + Math.round(A.vs / FT * 60), A.vs === null || !A.on);
    q('[data-k=ap]').classList.toggle('on', A.on); q('[data-k=athr]').classList.toggle('on', A.athr);
    const ab = q('[data-k=appr]'); ab.classList.toggle('on', !!(A.appr && A.gs)); ab.classList.toggle('arm', !!(A.appr && !A.gs));
  }
  function note(t) { notes.push({ t, age: 0 }); if (notes.length > 4) notes.shift(); }

  // ---------------------------------------------------------------- drawing helpers
  const txt = (s, x, y, size, col = COL.white, align = 'center', font = 'mono', weight = 600) => { g.font = `${weight} ${size}px ${font === 'mono' ? '"IBM Plex Mono", ui-monospace, monospace' : '"Barlow Condensed", "Barlow", sans-serif'}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(s, x, y); };
  const rr = (x, y, w, h, r, fill, stroke) => { g.beginPath(); g.roundRect(x, y, w, h, r); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.stroke(); } };

  // ---------------------------------------------------------------- the PFD (used on screen and on the panel)
  function pfd(F, cx, cy, s, opt = {}) {
    const ac = F.ac, o = ac.out, E = F.euler, T = F.type, A = F.fcs.ap;
    const S = 190 * s, half = S / 2, ppd = S / 36;                       // pixels per degree of pitch
    const kt = o.cas / KT, alt = ac.pos.y / FT, vs = o.vs / FT * 60;
    // ---- attitude
    g.save(); g.beginPath(); g.roundRect(cx - half, cy - half, S, S, 10 * s); g.clip();
    g.translate(cx, cy); g.rotate(-E.roll); g.translate(0, E.pitch / D * ppd);
    g.fillStyle = COL.sky; g.fillRect(-S * 2, -S * 4, S * 4, S * 4); g.fillStyle = COL.gnd; g.fillRect(-S * 2, 0, S * 4, S * 4);
    g.strokeStyle = COL.white; g.lineWidth = 1.6 * s; g.beginPath(); g.moveTo(-S * 2, 0); g.lineTo(S * 2, 0); g.stroke();
    for (let p = -90; p <= 90; p += 2.5) {
      if (!p) continue; const y = -p * ppd, major = p % 10 === 0, mid = p % 5 === 0; const w = major ? 34 * s : mid ? 18 * s : 8 * s;
      if (Math.abs(p - E.pitch / D) > 22) continue;
      g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
      if (major) { txt(String(Math.abs(p)), -w - 12 * s, y, 11 * s); txt(String(Math.abs(p)), w + 12 * s, y, 11 * s); }
    }
    g.restore();
    // bank scale
    g.save(); g.translate(cx, cy); g.strokeStyle = COL.white; g.lineWidth = 1.5 * s;
    const R = half * 0.86; g.beginPath(); g.arc(0, 0, R, -Math.PI / 2 - 60 * D, -Math.PI / 2 + 60 * D); g.stroke();
    for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) { const a = -Math.PI / 2 + b * D, l = Math.abs(b) % 30 === 0 ? 10 * s : 6 * s; g.beginPath(); g.moveTo(Math.cos(a) * R, Math.sin(a) * R); g.lineTo(Math.cos(a) * (R + l), Math.sin(a) * (R + l)); g.stroke(); }
    g.fillStyle = COL.white; g.beginPath(); g.moveTo(0, -R); g.lineTo(-6 * s, -R - 9 * s); g.lineTo(6 * s, -R - 9 * s); g.fill();
    g.rotate(-E.roll); g.fillStyle = Math.abs(E.roll) > 35 * D ? COL.amber : COL.white; g.beginPath(); g.moveTo(0, -R + 1); g.lineTo(-7 * s, -R + 11 * s); g.lineTo(7 * s, -R + 11 * s); g.fill();
    g.restore();
    // flight path vector (where the aircraft is actually going)
    const gs = Math.hypot(ac.vel.x, ac.vel.z), fpa = Math.atan2(ac.vel.y, Math.max(gs, 1)), trk = Math.atan2(ac.vel.x, -ac.vel.z);
    const drift = gs > 5 ? ((trk - E.hdg + 3 * Math.PI) % (2 * Math.PI)) - Math.PI : 0;
    const fx = clamp(drift / D * ppd, -half * 0.8, half * 0.8), fy = clamp((E.pitch - fpa) / D * ppd, -half * 0.8, half * 0.8);
    g.save(); g.translate(cx, cy); g.rotate(-E.roll); g.translate(Math.cos(E.roll) * fx - 0, fy);
    g.strokeStyle = COL.green; g.lineWidth = 2 * s; g.beginPath(); g.arc(0, 0, 6 * s, 0, 7); g.moveTo(-6 * s, 0); g.lineTo(-18 * s, 0); g.moveTo(6 * s, 0); g.lineTo(18 * s, 0); g.moveTo(0, -6 * s); g.lineTo(0, -13 * s); g.stroke(); g.restore();
    // aircraft symbol
    g.fillStyle = '#111'; g.strokeStyle = '#ffd400'; g.lineWidth = 3 * s;
    g.beginPath(); g.moveTo(cx - 62 * s, cy); g.lineTo(cx - 24 * s, cy); g.lineTo(cx - 24 * s, cy + 8 * s); g.moveTo(cx + 62 * s, cy); g.lineTo(cx + 24 * s, cy); g.lineTo(cx + 24 * s, cy + 8 * s); g.stroke();
    g.fillStyle = '#ffd400'; g.fillRect(cx - 3 * s, cy - 3 * s, 6 * s, 6 * s);
    // ILS deviation (synthetic glide path to the armed runway)
    if (A.rwy) {
      const R2 = A.rwy, dx = ac.pos.x - R2.x, dz = ac.pos.z - R2.z, along = dx * R2.ux + dz * R2.uz, cross = -dx * R2.uz + dz * R2.ux, toAim = 300 - along;
      if (toAim > 200 && toAim < 40000) {
        const loc = Math.atan2(cross, toAim) / D, gsd = Math.atan2(ac.pos.y - T.fdm.cgHeight - R2.elev, toAim) / D - 3;
        const ld = clamp(-loc / 1.25, -2.2, 2.2), gd = clamp(-gsd / 0.35, -2.2, 2.2), dot = half * 0.38;
        g.strokeStyle = COL.white; g.lineWidth = 1.4 * s;
        for (let k = -2; k <= 2; k++) { if (!k) continue; g.beginPath(); g.arc(cx + k * dot, cy + half - 12 * s, 3 * s, 0, 7); g.stroke(); g.beginPath(); g.arc(cx + half - 12 * s, cy + k * dot, 3 * s, 0, 7); g.stroke(); }
        g.fillStyle = COL.mag; const dia = (x, y) => { g.beginPath(); g.moveTo(x, y - 7 * s); g.lineTo(x + 5 * s, y); g.lineTo(x, y + 7 * s); g.lineTo(x - 5 * s, y); g.fill(); };
        dia(cx + ld * dot, cy + half - 12 * s); dia(cx + half - 12 * s, cy - gd * dot);
        txt(`${R2.apt} ${R2.ident}`, cx - half + 8 * s, cy + half - 12 * s, 10 * s, COL.mag, 'left');
      }
    }
    // radio altitude
    const ra = o.agl / FT; if (ra < 2500) txt(String(Math.max(0, Math.round(ra / (ra > 50 ? 10 : 1)) * (ra > 50 ? 10 : 1))), cx, cy + half * 0.62, 17 * s, ra < 400 ? COL.amber : COL.green);
    // ---- speed tape
    const tw = 62 * s, tx = cx - half - 8 * s - tw, ppk = 2.9 * s;
    rr(tx, cy - half, tw, S, 6 * s, COL.box); g.save(); g.beginPath(); g.rect(tx, cy - half, tw, S); g.clip();
    const vmo = T.v.mo || 999, mmoKt = (T.v.mmo || 9) * o.cas / Math.max(o.mach, 0.01) / KT, vmax = Math.min(vmo, mmoKt);
    const nF = Math.round(ac.flapPos), vfe = nF > 0 && T.v.fe ? T.v.fe[nF - 1] : null, vmaxEff = Math.min(vmax, vfe || 999, ac.gearPos > 0.1 && T.v.le ? T.v.le : 999);
    const vs1 = AIRCRAFT.vstall(T, ac.mass, Math.min(nF, T.fdm.flaps.length - 1)) * Math.sqrt(Math.max(0.5, o.nz));
    const yOf = (v) => cy - (v - kt) * ppk;
    g.fillStyle = COL.red; g.fillRect(tx + tw - 7 * s, yOf(vs1), 5 * s, S * 2);                 // stall
    g.fillStyle = COL.amber; g.fillRect(tx + tw - 7 * s, yOf(vs1 * 1.13), 5 * s, (vs1 * 0.13) * ppk);
    for (let y = yOf(vmaxEff); y > cy - half - 20; y -= 8 * s) { g.fillStyle = COL.red; g.fillRect(tx + tw - 7 * s, y - 4 * s, 5 * s, 4 * s); }
    g.strokeStyle = COL.white; g.lineWidth = 1.4 * s;
    for (let v = Math.floor((kt - 40) / 5) * 5; v <= kt + 40; v += 5) { if (v < 0) continue; const y = yOf(v); g.beginPath(); g.moveTo(tx + tw - 2, y); g.lineTo(tx + tw - (v % 10 ? 7 : 12) * s, y); g.stroke(); if (v % 20 === 0) txt(String(v), tx + tw - 18 * s, y, 12 * s, COL.white, 'right'); }
    if (A.spd !== null && (A.athr || A.on)) { const y = clamp(yOf(A.spd), cy - half + 4, cy + half - 4); g.fillStyle = COL.mag; g.beginPath(); g.moveTo(tx + tw, y); g.lineTo(tx + tw - 9 * s, y - 6 * s); g.lineTo(tx + tw - 9 * s, y + 6 * s); g.fill(); }
    const vr = F.cfg && F.cfg.vref; if (vr) { const y = yOf(vr); g.strokeStyle = COL.green; g.beginPath(); g.moveTo(tx + tw - 14 * s, y); g.lineTo(tx + tw, y); g.stroke(); }
    g.restore();
    if (Math.abs(trendKt) > 1) { g.strokeStyle = COL.green; g.lineWidth = 2 * s; const y2 = cy - clamp(trendKt, -40, 40) * ppk; g.beginPath(); g.moveTo(tx + tw + 3 * s, cy); g.lineTo(tx + tw + 3 * s, y2); g.stroke(); }
    rr(tx - 2 * s, cy - 13 * s, tw + 4 * s, 26 * s, 4 * s, '#000', COL.white); txt(String(Math.round(kt)), tx + tw / 2, cy, 17 * s, kt < vs1 * 1.1 ? COL.amber : COL.white);
    if (o.mach > 0.4) txt('M.' + o.mach.toFixed(3).slice(2), tx + tw / 2, cy + half + 12 * s, 12 * s, COL.green);
    if (A.spd !== null && (A.athr || A.on)) txt(String(A.spd), tx + tw / 2, cy - half - 11 * s, 12 * s, COL.mag);
    // ---- altitude tape
    const aw = 70 * s, ax = cx + half + 8 * s, ppf = 0.14 * s;
    rr(ax, cy - half, aw, S, 6 * s, COL.box); g.save(); g.beginPath(); g.rect(ax, cy - half, aw, S); g.clip();
    const yA = (a) => cy - (a - alt) * ppf;
    const gy = yA(o.gnd / FT); if (gy < cy + half) { g.fillStyle = 'rgba(140,82,30,.75)'; g.fillRect(ax, gy, aw, S); }
    g.strokeStyle = COL.white; g.lineWidth = 1.4 * s;
    for (let a = Math.floor((alt - 800) / 100) * 100; a <= alt + 800; a += 100) { const y = yA(a); g.beginPath(); g.moveTo(ax, y); g.lineTo(ax + (a % 500 ? 6 : 11) * s, y); g.stroke(); if (a % 500 === 0) txt(String(a), ax + 15 * s, y, 11.5 * s, COL.white, 'left'); }
    if (A.alt !== null && A.on) { const y = clamp(yA(A.alt / FT), cy - half + 4, cy + half - 4); g.strokeStyle = COL.cyan; g.lineWidth = 2.5 * s; g.beginPath(); g.moveTo(ax + 1, y - 7 * s); g.lineTo(ax + 7 * s, y); g.lineTo(ax + 1, y + 7 * s); g.stroke(); }
    g.restore();
    rr(ax - 2 * s, cy - 13 * s, aw + 4 * s, 26 * s, 4 * s, '#000', COL.white); txt(String(Math.round(alt / 10) * 10), ax + aw / 2, cy, 15.5 * s);
    if (A.alt !== null && A.on) txt(String(Math.round(A.alt / FT)), ax + aw / 2, cy - half - 11 * s, 12 * s, COL.cyan);
    txt('STD', ax + aw / 2, cy + half + 12 * s, 11 * s, COL.cyan);
    // ---- vertical speed
    const vx = ax + aw + 6 * s, vw = 30 * s; rr(vx, cy - half * 0.8, vw, S * 0.8, 5 * s, COL.box);
    const vsy = (v) => cy - Math.sign(v) * Math.min(1, Math.sqrt(Math.abs(v) / 6000)) * half * 0.74;
    g.strokeStyle = COL.white; g.lineWidth = 1 * s; for (const v of [-6000, -2000, -1000, -500, 0, 500, 1000, 2000, 6000]) { const y = vsy(v); g.beginPath(); g.moveTo(vx, y); g.lineTo(vx + (v % 1000 ? 4 : 8) * s, y); g.stroke(); }
    g.strokeStyle = Math.abs(vs) > 6000 ? COL.amber : COL.green; g.lineWidth = 2.5 * s; g.beginPath(); g.moveTo(vx + vw, cy); g.lineTo(vx + 4 * s, vsy(vs)); g.stroke();
    if (Math.abs(vs) > 150) txt(String(Math.round(vs / 50) * 50), vx + vw / 2, vs > 0 ? cy - half * 0.8 - 10 * s : cy + half * 0.8 + 10 * s, 11 * s, COL.green);
    // ---- heading tape
    const hy = cy + half + 26 * s, hw = S + tw + aw, hx = cx - hw / 2, pph = 3.6 * s, hdg = E.hdg / D;
    rr(hx, hy - 12 * s, hw, 26 * s, 5 * s, COL.box); g.save(); g.beginPath(); g.rect(hx, hy - 12 * s, hw, 26 * s); g.clip();
    g.strokeStyle = COL.white; g.lineWidth = 1.3 * s;
    for (let h = Math.floor((hdg - 50) / 5) * 5; h <= hdg + 50; h += 5) { const x = cx + (h - hdg) * pph; g.beginPath(); g.moveTo(x, hy - 12 * s); g.lineTo(x, hy - 12 * s + (h % 10 ? 5 : 9) * s); g.stroke();
      if (h % 10 === 0) { const n = ((h % 360) + 360) % 360; txt(n % 90 === 0 ? 'NESW'[n / 90] : String(n / 10), x, hy + 5 * s, 11.5 * s); } }
    if (A.hdg !== null && A.on && !A.appr) { const d = ((A.hdg / D - hdg + 540) % 360) - 180, x = clamp(cx + d * pph, hx + 6, hx + hw - 6); g.fillStyle = COL.cyan; g.fillRect(x - 5 * s, hy - 12 * s, 10 * s, 5 * s); }
    const trkD = ((trk / D - hdg + 540) % 360) - 180; if (gs > 5) { g.strokeStyle = COL.green; const x = cx + trkD * pph; g.beginPath(); g.moveTo(x, hy - 12 * s); g.lineTo(x - 4 * s, hy - 5 * s); g.lineTo(x, hy + 2 * s); g.lineTo(x + 4 * s, hy - 5 * s); g.closePath(); g.stroke(); }
    g.restore();
    g.fillStyle = '#ffd400'; g.beginPath(); g.moveTo(cx, hy - 12 * s); g.lineTo(cx - 5 * s, hy - 19 * s); g.lineTo(cx + 5 * s, hy - 19 * s); g.fill();
    rr(cx - 20 * s, hy + 15 * s, 40 * s, 18 * s, 4 * s, '#000', COL.white); txt(String(Math.round(hdg) % 360 || 360).padStart(3, '0'), cx, hy + 24 * s, 12.5 * s);
    // ---- flight mode annunciators
    if (!opt.noFma) {
      const fy = cy - half - 30 * s, fw = S + tw + aw + vw, x0 = cx - (S + tw + aw) / 2 - 8 * s;
      rr(x0, fy - 12 * s, fw + 16 * s, 24 * s, 5 * s, COL.box);
      const cols = [
        A.athr ? (A.retard ? 'RETARD' : 'SPEED') : ac.ctl.thr >= 0.98 ? (ac.ctl.thr > 1 ? 'MAX AB' : 'TOGA') : ac.ctl.thr < 0.02 ? 'IDLE' : 'MAN THR',
        A.on ? (A.flare ? 'FLARE' : A.gs ? 'G/S' : A.appr ? (A.alt !== null ? 'ALT  G/S' : 'G/S') : A.vs !== null && A.alt !== null && Math.abs(A.alt - ac.pos.y) > 60 ? 'V/S' : 'ALT') : F.fcs.flare ? 'FLARE' : F.fcs.law === 'flight' ? 'FPA' : '',
        A.on ? (A.appr ? (A.loc ? 'LOC' : 'HDG  LOC') : 'HDG') : '',
        A.on ? 'AP' : '', ({ full: 'ASSIST', fbw: 'FBW', direct: 'DIRECT' })[F.fcs.assist],
      ];
      cols.forEach((t, i) => txt(t, x0 + 8 * s + (i + 0.5) * (fw / 5), fy, 11.5 * s, i === 0 ? (A.athr ? COL.green : COL.white) : i === 3 ? COL.white : i === 4 ? COL.cyan : COL.green));
    }
  }

  // ---------------------------------------------------------------- engines / configuration box
  function systems(F, x, y, s) {
    const ac = F.ac, T = F.type, o = ac.out, c = ac.ctl, n = ac.eng.length;
    const w = Math.max(170, 60 + n * 52) * s, h = 150 * s; rr(x - w, y - h, w, h, 8 * s, COL.box);
    const prop = T.fdm.engines[0].type === 'prop';
    ac.eng.forEach((e, i) => {
      const cx = x - w + 36 * s + i * 52 * s, cy = y - h + 42 * s, r = 20 * s, v = clamp((e.n - 0.2) / 0.8, 0, 1.05);
      g.strokeStyle = COL.line; g.lineWidth = 5 * s; g.beginPath(); g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); g.stroke();
      g.strokeStyle = c.rev && o.onGround ? COL.amber : COL.green; g.beginPath(); g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * Math.min(1, v))); g.stroke();
      const lev = Math.PI * (0.75 + 1.5 * clamp(c.thr, 0, 1)); g.fillStyle = COL.cyan; g.beginPath(); g.arc(cx + Math.cos(lev) * (r + 6 * s), cy + Math.sin(lev) * (r + 6 * s), 2.6 * s, 0, 7); g.fill();
      txt(prop ? String(Math.round(600 + 2100 * v)) : (20 + v * 80).toFixed(1), cx, cy + 2 * s, 10.5 * s);
      txt(c.rev && o.onGround ? 'REV' : c.thr > 1.001 ? 'AB' : prop ? 'RPM' : 'N1', cx, cy + r + 8 * s, 9.5 * s, c.rev && o.onGround ? COL.amber : c.thr > 1.001 ? COL.amber : COL.white);
    });
    const fl = T.fdm.flaps, fi = Math.round(c.flaps), moving = Math.abs(ac.flapPos - c.flaps) > 0.02;
    txt('FLAPS', x - w + 12 * s, y - 52 * s, 11 * s, COL.white, 'left', 'mono', 500); txt(fl[fi].label, x - w + 66 * s, y - 52 * s, 12 * s, moving ? COL.amber : COL.green, 'left');
    if (T.fdm.retract) { const gp = ac.gearPos; const col = gp > 0.99 ? COL.green : gp < 0.01 ? null : COL.red; txt('GEAR', x - w + 12 * s, y - 33 * s, 11 * s, COL.white, 'left', 'mono', 500);
      if (col) for (let k = 0; k < 3; k++) rr(x - w + 66 * s + k * 20 * s, y - 40 * s, 16 * s, 14 * s, 2 * s, col === COL.green ? 'rgba(62,240,138,.25)' : 'rgba(255,59,48,.3)', col); else txt('UP', x - w + 66 * s, y - 33 * s, 12 * s, COL.white, 'left'); }
    const tags = [];
    if (ac.spoilerPos > 0.05) tags.push(['SPD BRK', COL.amber]); if (c.park) tags.push(['PARK BRK', COL.amber]); else if (c.brake > 0.05) tags.push(['BRAKES', COL.amber]);
    if (F.fcs.assist === 'direct' && Math.abs(c.trim) > 0.01) tags.push(['TRIM ' + (c.trim > 0 ? 'UP ' : 'DN ') + Math.round(Math.abs(c.trim) * 100), COL.cyan]);
    tags.forEach(([t, col], i) => txt(t, x - w + 12 * s + (i % 2) * (w / 2), y - 14 * s, 10.5 * s, col, 'left'));
  }
  function info(F, x, y, s) {
    const ac = F.ac, o = ac.out; const ll = Globe.w2ll(ac.pos.x, ac.pos.z);
    const atm = FDM.atmosphere(ac.pos.y), lines = [
      ['GS', Math.round(o.gs / KT) + ' kt'], ['TAS', Math.round(o.tas / KT) + ' kt'], ['WIND', windText(ac)], ['OAT', (typeof Weather !== 'undefined' && Weather.now ? Math.round(Weather.now.temp - (ac.pos.y - Weather.now.elev) * 0.0065) : Math.round(atm.T - 273.15)) + '°C'],
      ['POS', `${Math.abs(ll.lat).toFixed(3)}${ll.lat >= 0 ? 'N' : 'S'} ${Math.abs(ll.lon).toFixed(3)}${ll.lon >= 0 ? 'E' : 'W'}`], ['TIME', fmtT(F.flightTime)]];
    const w = 200 * s, h = (lines.length * 17 + 12) * s; y -= (lines.length - 5) * 17 * s; rr(x, y, w, h, 8 * s, COL.box);
    lines.forEach(([k, v], i) => { txt(k, x + 10 * s, y + (14 + i * 17) * s, 10.5 * s, COL.line.replace('.18', '.6'), 'left', 'mono', 500); txt(v, x + w - 10 * s, y + (14 + i * 17) * s, 11 * s, COL.white, 'right'); });
  }
  function windText(ac) { const w = Flight.wind; if (!w || w.lengthSq() < 0.25) return 'CALM'; const from = (Math.atan2(-w.x, w.z) / D + 360) % 360; return String(Math.round(from / 10) * 10 % 360 || 360).padStart(3, '0') + '° / ' + Math.round(Math.hypot(w.x, w.z) / KT) + ' kt'; }
  const fmtT = (t) => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t) % 60).padStart(2, '0')}`;

  // ---------------------------------------------------------------- conformal HUD (cockpit view)
  const pv = new THREE.Vector3();
  function project(dir) { const c = Env.camera; pv.copy(c.position).addScaledVector(dir, 1000).project(c); return pv.z < 1 ? [(pv.x + 1) / 2 * W, (1 - pv.y) / 2 * H] : null; }
  function projectPos(p) { const c = Env.camera; pv.copy(p).project(c); return pv.z < 1 && pv.z > -1 ? [(pv.x + 1) / 2 * W, (1 - pv.y) / 2 * H] : null; }
  function hud(F, s) {
    const ac = F.ac, E = F.euler; g.save(); g.strokeStyle = 'rgba(80,255,140,.85)'; g.fillStyle = 'rgba(80,255,140,.85)'; g.lineWidth = 1.6 * s;
    const dir = (hd, el) => new THREE.Vector3(Math.sin(hd) * Math.cos(el), Math.sin(el), -Math.cos(hd) * Math.cos(el));
    for (let p = -30; p <= 30; p += 5) {
      const a = project(dir(E.hdg - 4 * D, p * D)), b = project(dir(E.hdg + 4 * D, p * D)); if (!a || !b) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; if (Math.abs(mx - W / 2) > W * 0.3 || Math.abs(my - H / 2) > H * 0.36) continue;
      g.setLineDash(p < 0 ? [6 * s, 5 * s] : []); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      if (p) { g.font = `600 ${11 * s}px "IBM Plex Mono", monospace`; g.textAlign = 'left'; g.fillText(String(p), b[0] + 5, b[1] + 4); }
    }
    g.setLineDash([]);
    const vel = ac.vel.clone(); if (vel.length() > 5) { const p = project(vel.normalize()); if (p) { g.beginPath(); g.arc(p[0], p[1], 7 * s, 0, 7); g.moveTo(p[0] - 7 * s, p[1]); g.lineTo(p[0] - 20 * s, p[1]); g.moveTo(p[0] + 7 * s, p[1]); g.lineTo(p[0] + 20 * s, p[1]); g.moveTo(p[0], p[1] - 7 * s); g.lineTo(p[0], p[1] - 14 * s); g.stroke(); } }
    g.restore();
  }

  // speed, altitude, vertical speed and heading around the conformal HUD (cockpit)
  function hudData(F, s) {
    const ac = F.ac, o = ac.out, A = F.fcs.ap, col = 'rgba(80,255,140,.9)';
    const cx = W / 2, cy = H * 0.45, dx = Math.min(W * 0.22, 330 * s);
    const box = (x, y, t, al) => { g.strokeStyle = col; g.lineWidth = 1.5 * s; g.strokeRect(x - 38 * s, y - 13 * s, 76 * s, 26 * s); txt(t, x, y, 15 * s, col); };
    box(cx - dx, cy, String(Math.round(o.cas / KT))); box(cx + dx, cy, String(Math.round(ac.pos.y / FT / 10) * 10));
    txt(o.mach > 0.4 ? 'M ' + o.mach.toFixed(2) : Math.round(o.gs / KT) + ' GS', cx - dx, cy + 26 * s, 11 * s, col);
    txt((o.vs >= 0 ? '+' : '') + Math.round(o.vs / FT * 60 / 10) * 10, cx + dx, cy + 26 * s, 11 * s, col);
    if (o.agl / FT < 2500) txt(Math.max(0, Math.round(o.agl / FT)) + ' R', cx + dx, cy + 44 * s, 12 * s, col);
    txt(String(Math.round(F.euler.hdg / D) % 360 || 360).padStart(3, '0'), cx, cy - H * 0.3, 14 * s, col);
    const fl = F.type.fdm.flaps[Math.round(ac.ctl.flaps)].label, thr = Math.round(ac.ctl.thr * 100);
    txt(`THR ${thr}%  ·  FLAPS ${fl}${F.type.fdm.retract ? '  ·  GEAR ' + (ac.gearPos > 0.99 ? 'DN' : ac.gearPos < 0.01 ? 'UP' : '···') : ''}${A.on ? '  ·  AP' : ''}${A.athr ? '  ·  A/THR ' + A.spd : ''}`, cx, cy - H * 0.3 + 22 * s, 11 * s, col);
  }

  // ---------------------------------------------------------------- warnings and notes
  function warnings(F, s, dt) {
    const L = F.warn.list; const blink = (performance.now() / 350 | 0) % 2 === 0;
    L.slice(0, 3).forEach((t, i) => { const red = /STALL|PULL UP|OVERSPEED|TOO LOW|TAIL/.test(t); const w = Math.max(140, t.length * 12) * s;
      rr(W / 2 - w / 2, (W < 1320 ? 140 : 80) * s + i * 34 * s, w, 28 * s, 6 * s, red ? (blink ? 'rgba(200,20,10,.85)' : 'rgba(120,10,5,.85)') : 'rgba(40,30,0,.8)', red ? '#ff6a5e' : COL.amber);
      txt(t, W / 2, (W < 1320 ? 154 : 94) * s + i * 34 * s, 15 * s, red ? '#fff' : COL.amber); });
    notes = notes.filter(n => (n.age += dt) < 2.2);
    notes.forEach((n, i) => { const a = Math.min(1, (2.2 - n.age) * 2); g.globalAlpha = a; rr(W / 2 - 110 * s, H * 0.3 + i * 30 * s, 220 * s, 24 * s, 6 * s, 'rgba(8,10,14,.7)'); txt(n.t, W / 2, H * 0.3 + 12 * s + i * 30 * s, 13 * s, COL.green); g.globalAlpha = 1; });
  }

  // ---------------------------------------------------------------- the cockpit instrument panel (canvas texture)
  function panel(F) {
    const P = F.model.panel, c = P.canvas, pg = c.getContext('2d'), T = F.type, save = g, sW = W, sH = H;
    g = pg; W = c.width; H = c.height;
    pg.fillStyle = '#16191d'; pg.fillRect(0, 0, W, H);
    if (T.model.kind === 'ga') gauges(F);
    else {
      const s = 0.95; pg.fillStyle = '#050608'; for (const x of [18, 356, 684]) pg.fillRect(x, 16, 318, 352);
      pfd(F, 18 + 159, 16 + 170, s * 0.78, { noFma: false });
      nd(F, 356 + 159, 16 + 176, 150);
      pfd(F, 684 + 159, 16 + 170, s * 0.78, { noFma: true });
    }
    g = save; W = sW; H = sH;
    P.tex.needsUpdate = true;
  }
  function nd(F, cx, cy, R) {     // navigation display: heading-up map of nearby airports and runways
    const ac = F.ac, E = F.euler, range = 20 * NM, k = R / range;
    g.save(); g.beginPath(); g.rect(cx - R - 10, cy - R - 20, 2 * R + 20, 2 * R + 30); g.clip();
    g.strokeStyle = COL.white; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy + R * 0.5, R * 1.2, Math.PI * 1.2, Math.PI * 1.8); g.stroke();
    const ll = Globe.w2ll(ac.pos.x, ac.pos.z);
    const toScr = (x, z) => { const dx = x - ac.pos.x, dz = z - ac.pos.z, c2 = Math.cos(-E.hdg), s2 = Math.sin(-E.hdg); const rx = dx * c2 - dz * s2, rz = dx * s2 + dz * c2; return [cx + rx * k, cy + R * 0.5 + rz * k]; };
    for (const n of Airports.near(ll.lat, ll.lon, range * 1.3)) {
      const a = n.apt; const w = Globe.ll2w(a.lat, a.lon), p = toScr(w.x, w.z);
      g.strokeStyle = COL.cyan; g.lineWidth = 2;
      for (const rw of a.runways) { if (rw.approx) continue; const G2 = Airports.geom(a, rw), p1 = toScr(G2.ax, G2.az), p2 = toScr(G2.bx, G2.bz); g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke(); }
      if (a.type < 2) txt(a.ident, p[0] + 8, p[1] - 8, 11, COL.cyan, 'left');
    }
    if (F.fcs.ap.rwy) { const r2 = F.fcs.ap.rwy; const p1 = toScr(r2.x, r2.z), p2 = toScr(r2.x - r2.ux * 15000, r2.z - r2.uz * 15000); g.strokeStyle = COL.mag; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke(); g.setLineDash([]); }
    g.fillStyle = '#ffd400'; g.beginPath(); g.moveTo(cx, cy + R * 0.5 - 10); g.lineTo(cx - 7, cy + R * 0.5 + 8); g.lineTo(cx + 7, cy + R * 0.5 + 8); g.fill();
    g.restore();
    txt(String(Math.round(E.hdg / D) % 360).padStart(3, '0') + '°', cx, cy - R + 4, 14, COL.white);
    txt('GS ' + Math.round(ac.out.gs / KT) + '  TAS ' + Math.round(ac.out.tas / KT), cx - R + 4, cy - R - 8, 11, COL.white, 'left');
    txt('20 NM', cx + R - 4, cy - R - 8, 11, COL.cyan, 'right');
  }
  function gauges(F) {       // the Cessna's six-pack and tachometer
    const ac = F.ac, o = ac.out, E = F.euler, pg = g;
    const dial = (x, y, r, label) => { pg.fillStyle = '#0c0d0f'; pg.beginPath(); pg.arc(x, y, r, 0, 7); pg.fill(); pg.strokeStyle = '#555'; pg.lineWidth = 3; pg.stroke(); txt(label, x, y + r * 0.45, 12, '#aaa', 'center', 'mono', 500); };
    const needle = (x, y, r, a, col = '#f0f0f0') => { pg.strokeStyle = col; pg.lineWidth = 4; pg.beginPath(); pg.moveTo(x, y); pg.lineTo(x + Math.sin(a) * r * 0.82, y - Math.cos(a) * r * 0.82); pg.stroke(); };
    const r = 70, xs = [110, 280, 450], ys = [100, 280];
    // airspeed
    dial(xs[0], ys[0], r, 'KNOTS'); const kt = o.cas / KT; for (let v = 40; v <= 200; v += 20) { const a = (v - 20) / 180 * Math.PI * 1.7 - Math.PI * 0.85; txt(String(v), xs[0] + Math.sin(a) * r * 0.66, ys[0] - Math.cos(a) * r * 0.66, 11, '#ddd'); }
    needle(xs[0], ys[0], r, (clamp(kt, 20, 200) - 20) / 180 * Math.PI * 1.7 - Math.PI * 0.85);
    // attitude
    pg.save(); pg.beginPath(); pg.arc(xs[1], ys[0], r, 0, 7); pg.clip(); pg.translate(xs[1], ys[0]); pg.rotate(-E.roll); pg.translate(0, E.pitch / D * 3);
    pg.fillStyle = COL.sky; pg.fillRect(-r * 2, -r * 3, r * 4, r * 3); pg.fillStyle = COL.gnd; pg.fillRect(-r * 2, 0, r * 4, r * 3); pg.strokeStyle = '#fff'; pg.lineWidth = 2; pg.beginPath(); pg.moveTo(-r, 0); pg.lineTo(r, 0); pg.stroke(); pg.restore();
    pg.strokeStyle = '#ffb000'; pg.lineWidth = 4; pg.beginPath(); pg.moveTo(xs[1] - 36, ys[0]); pg.lineTo(xs[1] - 12, ys[0]); pg.moveTo(xs[1] + 36, ys[0]); pg.lineTo(xs[1] + 12, ys[0]); pg.stroke();
    // altimeter
    dial(xs[2], ys[0], r, 'ALT'); const alt = ac.pos.y / FT; for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; txt(String(k), xs[2] + Math.sin(a) * r * 0.7, ys[0] - Math.cos(a) * r * 0.7, 12, '#ddd'); }
    needle(xs[2], ys[0], r, (alt % 1000) / 1000 * Math.PI * 2); needle(xs[2], ys[0], r * 0.6, (alt % 10000) / 10000 * Math.PI * 2, '#cfcfcf');
    txt(String(Math.round(alt)), xs[2], ys[0] + 26, 12, '#9f9');
    // turn coordinator, heading, VSI
    dial(xs[0], ys[1], r, 'TURN'); pg.save(); pg.translate(xs[0], ys[1]); pg.rotate(clamp(-F.ac.omega.z * 3, -0.6, 0.6) * 0 + clamp(E.roll, -0.6, 0.6)); pg.strokeStyle = '#fff'; pg.lineWidth = 5; pg.beginPath(); pg.moveTo(-40, 0); pg.lineTo(40, 0); pg.stroke(); pg.restore();
    pg.fillStyle = '#ddd'; pg.beginPath(); pg.arc(xs[0] + clamp(o.beta / D * 3, -30, 30), ys[1] + 30, 7, 0, 7); pg.fill();
    dial(xs[1], ys[1], r, ''); pg.save(); pg.translate(xs[1], ys[1]); pg.rotate(-E.hdg);
    for (let h = 0; h < 360; h += 30) { pg.save(); pg.rotate(h * D); txt(h % 90 === 0 ? 'NESW'[h / 90] : String(h / 10), 0, -r * 0.72, 13, '#eee'); pg.restore(); } pg.restore();
    pg.fillStyle = '#ffb000'; pg.beginPath(); pg.moveTo(xs[1], ys[1] - 18); pg.lineTo(xs[1] - 10, ys[1] + 14); pg.lineTo(xs[1] + 10, ys[1] + 14); pg.fill();
    dial(xs[2], ys[1], r, 'VS'); const vsf = o.vs / FT * 60; needle(xs[2], ys[1], r, -Math.PI / 2 + clamp(vsf / 2000, -1, 1) * Math.PI * 0.85);
    // tach + flaps + fuel-ish
    dial(640, ys[0], 60, 'RPM x100'); const n = clamp((ac.eng[0].n - 0.2) / 0.8, 0, 1); needle(640, ys[0], 60, -Math.PI * 0.75 + n * Math.PI * 1.5, '#9f9'); txt(String(Math.round(600 + 2100 * n)), 640, ys[0] + 22, 12, '#9f9');
    txt('FLAPS ' + F.type.fdm.flaps[Math.round(ac.ctl.flaps)].label, 640, ys[1] - 30, 14, '#ddd'); txt('THR ' + Math.round(ac.ctl.thr * 100) + '%', 640, ys[1], 14, '#ddd');
    txt(fmtT(F.flightTime), 640, ys[1] + 30, 14, '#9f9');
    // right side: a moving map
    nd(F, 870, 200, 140);
  }

  // ---------------------------------------------------------------- per frame
  function draw(F, dt) {
    if (!shown || !F.ac) return;
    const kt = F.ac.out.cas / KT; if (lastKt !== null && dt > 0) trendKt += (((kt - lastKt) / dt) * 10 - trendKt) * Math.min(1, dt * 2); lastKt = kt;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const s = clamp(Math.min(H / 1000, W / 1500), 0.6, 1.25);
    const cockpit = F.cam.mode === 'cockpit';
    if (cockpit) hud(F, s);
    const small = W < 760;
    if (!cockpit) pfd(F, W / 2, H - (small ? 160 : 175) * s, small ? s * 0.8 : s);
    else hudData(F, s);
    if (!small) { systems(F, W - 16, H - 16, s); info(F, 16, H - 16 - 104 * s, s); }
    warnings(F, s, dt);
    fcuUpdate(F, dt);
    if (typeof FMissions !== 'undefined') FMissions.hudMarker(g, W, H, projectPos);
    // the panel texture ~12 times a second while in the cockpit
    if (cockpit) { panelT -= dt; if (panelT <= 0) { panelT = 0.08; panel(F); } }
  }

  // ---------------------------------------------------------------- setup screen
  const FAMOUS = [['KSFO', 'San Francisco'], ['KJFK', 'New York JFK'], ['EGLL', 'London Heathrow'], ['LFPG', 'Paris CDG'], ['RJTT', 'Tokyo Haneda'], ['VHHH', 'Hong Kong'], ['OMDB', 'Dubai'],
    ['YSSY', 'Sydney'], ['LOWI', 'Innsbruck'], ['LXGB', 'Gibraltar'], ['TNCM', 'St Maarten'], ['LPMA', 'Madeira'], ['VQPR', 'Paro, Bhutan'], ['NZQN', 'Queenstown'], ['PHNL', 'Honolulu'], ['BIKF', 'Keflavik'], ['KPAO', 'Palo Alto'], ['LSZH', 'Zurich']];
  let sel = { type: null, apt: null, rw: '', pos: 'runway', time: 'now', assist: 'full' };
  function setup(open = true) {
    if (!setupEl) buildSetup();
    setupEl.hidden = !open; if (!open) return;
    UI.closeAll(); Player.releaseLock && Player.releaseLock();
    const P = Flight.prefs; sel.type = sel.type || P.type || 'a320'; sel.assist = P.assist || 'full';
    Airports.load().then(() => {
      if (!sel.apt) { const cp = Env.camera.position, ll = Globe.w2ll(cp.x, cp.z); const n = Airports.nearest(ll.lat, ll.lon, a => a.type < 2, 300000); sel.apt = (P.apt && Airports.byIdent(P.apt)) || (n && n.apt) || Airports.byIdent('KSFO'); }
      renderSetup();
    });
    renderSetup();
  }
  function buildSetup() {
    setupEl = document.createElement('div'); setupEl.className = 'fov'; setupEl.id = 'flightsetup'; setupEl.hidden = true;
    setupEl.innerHTML = `<div class="card panel"><button class="close" data-x>×</button><div class="kicker">Bayline Flight · any airport on Earth</div><h2>Where do you want to fly?</h2>
      <div class="kicker" style="margin:4px 0 8px;color:var(--ink-faint)">Challenges</div><div class="fgrid" id="fs-ch" style="grid-template-columns:repeat(4,1fr)"></div>
      <div class="kicker" style="margin:16px 0 8px;color:var(--ink-faint)">Or free flight: pick an aircraft</div>
      <div class="fgrid" id="fs-types"></div>
      <div class="frow" style="margin-top:14px"><label>Airport</label><input class="fsearch" id="fs-q" placeholder="ICAO, IATA, city or name: KSFO, LHR, Innsbruck, Lukla…" autocomplete="off" spellcheck="false"></div>
      <div class="fres" id="fs-res"></div>
      <div class="frow" id="fs-famous"></div>
      <div class="frow"><label>Runway</label><select class="fsel" id="fs-rw"></select><span style="flex:1"></span><span id="fs-apt" style="color:var(--ink-dim);font-size:13px"></span></div>
      <div class="frow" id="fs-pos"><label>Start</label><button class="chip" data-v="runway">On the runway</button><button class="chip" data-v="final">8 nm final</button><button class="chip" data-v="air">In the air</button></div>
      <div class="frow" id="fs-time"><label>Time</label><button class="chip" data-v="now">Now (local)</button><button class="chip" data-v="6.5">Dawn</button><button class="chip" data-v="12">Noon</button><button class="chip" data-v="golden">Golden hour</button><button class="chip" data-v="22">Night</button></div>
      <div class="frow" id="fs-assist"><label>Handling</label><button class="chip" data-v="full">Assisted (fly-by-wire + auto-flare)</button><button class="chip" data-v="fbw">Fly-by-wire</button><button class="chip" data-v="direct">Direct</button></div>
      <div class="frow" style="margin-top:14px"><button class="btn primary" id="fs-go" style="padding:12px 26px;font-size:16px">Fly</button><span style="color:var(--ink-faint);font-size:13px">W/S throttle · arrows fly · F/R flaps · G gear · Space brakes · C camera · I approach · Y autopilot · Esc menu · H all keys</span></div>
      <div class="fnote">Aircraft types are named for identification only; all wear the fictional Bayline Air scheme. Not affiliated with any manufacturer or airline. Performance from public data, simplified. Airports and runways: OurAirports (public domain). Terrain: AWS Terrain Tiles. Imagery: USGS NAIP (US), EOxCloudless 2025 by EOX IT Services GmbH (contains modified Copernicus Sentinel data). City lights: NASA GIBS / VIIRS Black Marble. Weather: Open-Meteo (CC BY 4.0). Live traffic: adsb.lol (ODbL), a few seconds behind real time. Not for real-world navigation.</div></div>`;
    document.body.appendChild(setupEl);
    setupEl.addEventListener('mousedown', (e) => { if (e.target === setupEl) setup(false); });
    setupEl.querySelector('[data-x]').onclick = () => setup(false);
    const q = setupEl.querySelector('#fs-q');
    q.addEventListener('input', () => renderResults(q.value));
    q.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const r = Airports.search(q.value, 1)[0]; if (r) { sel.apt = r.apt; sel.rw = ''; renderSetup(); } } });
    for (const [id, key] of [['fs-pos', 'pos'], ['fs-time', 'time'], ['fs-assist', 'assist']]) setupEl.querySelector('#' + id).addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; sel[key] = b.dataset.v; renderSetup(); });
    setupEl.querySelector('#fs-rw').onchange = (e) => { sel.rw = e.target.value; };
    setupEl.querySelector('#fs-go').onclick = go;
  }
  function renderResults(qs) {
    const el = setupEl.querySelector('#fs-res'); const R = Airports.search(qs, 8);
    el.innerHTML = R.map((r, i) => `<button data-i="${i}" class="${sel.apt === r.apt ? 'on' : ''}"><b>${r.apt.ident}</b>${esc(r.apt.name)} <span>· ${esc(r.apt.city || '')} ${esc(Airports.COUNTRY(r.apt.country))} · ${Math.round(Math.max(...r.apt.runways.map(w => w.L)))} m</span></button>`).join('');
    el.querySelectorAll('button').forEach(b => b.onclick = () => { sel.apt = R[+b.dataset.i].apt; sel.rw = ''; renderSetup(); });
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderSetup() {
    if (!setupEl) return;
    const ch = setupEl.querySelector('#fs-ch');
    if (typeof FMissions !== 'undefined') { ch.innerHTML = FMissions.list.map(m => `<button class="fcard" data-m="${m.id}"><b>${m.title}</b><small>${m.sub}</small>${FMissions.best[m.id] ? `<div class="facts">best ${FMissions.best[m.id]}</div>` : ''}</button>`).join('');
      ch.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { setup(false); if (typeof World !== 'undefined' && !World.started && window.__bayline) window.__bayline.start('fly'); Flight.prefs.assist = sel.assist; FMissions.start(b.dataset.m).catch(e => console.error(e)); }); }
    const types = setupEl.querySelector('#fs-types');
    types.innerHTML = AIRCRAFT.list.map(a => `<button class="fcard ${sel.type === a.id ? 'on' : ''}" data-id="${a.id}"><b>${a.name}</b><small>${a.cat} · ${a.blurb}</small><div class="facts">${a.facts.join(' · ')}</div></button>`).join('');
    types.querySelectorAll('.fcard').forEach(b => b.onclick = () => { sel.type = b.dataset.id; renderSetup(); });
    const fam = setupEl.querySelector('#fs-famous');
    fam.innerHTML = '<label>Try</label>' + FAMOUS.map(([id, n]) => `<button class="chip ${sel.apt && sel.apt.ident === id ? 'on' : ''}" data-id="${id}">${n}</button>`).join('');
    fam.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const a = Airports.byIdent(b.dataset.id); if (a) { sel.apt = a; sel.rw = ''; renderSetup(); } });
    const a = sel.apt, rwSel = setupEl.querySelector('#fs-rw');
    if (a) {
      const opts = ['<option value="">Best for the wind</option>'];
      for (const rw of a.runways) { if (rw.approx) continue; for (const [id] of [[rw.le], [rw.he]]) opts.push(`<option value="${esc(id)}" ${sel.rw === id ? 'selected' : ''}>Runway ${esc(id)} · ${Math.round(rw.L)} m${rw.surf === 1 ? ' (grass/dirt)' : rw.surf === 2 ? ' (water)' : ''}</option>`); }
      rwSel.innerHTML = opts.join('');
      setupEl.querySelector('#fs-apt').textContent = `${a.ident}${a.iata ? ' / ' + a.iata : ''} · ${a.name} · ${a.city || ''} ${Airports.COUNTRY(a.country)} · ${Math.round(a.elev / FT)} ft`;
    }
    for (const [id, key] of [['fs-pos', 'pos'], ['fs-time', 'time'], ['fs-assist', 'assist']]) setupEl.querySelectorAll(`#${id} [data-v]`).forEach(b => b.classList.toggle('on', b.dataset.v === String(sel[key])));
    const q = setupEl.querySelector('#fs-q'); if (q.value) renderResults(q.value); else setupEl.querySelector('#fs-res').innerHTML = '';
  }
  function go() {
    if (!sel.apt) { UI.toast('Pick an airport first'); return; }
    setup(false);
    let time = sel.time === 'now' ? 'now' : sel.time === 'golden' ? null : +sel.time;
    if (sel.time === 'golden') { time = goldenHour(sel.apt); }
    if (typeof World !== 'undefined' && !World.started && window.__bayline) window.__bayline.start('fly');
    Flight.prefs.assist = sel.assist;
    UI.toast('Preparing ' + sel.apt.ident + '…', 3);
    if (typeof FMissions !== 'undefined') FMissions.clear();
    Flight.start({ type: sel.type, apt: sel.apt, rwIdent: sel.rw || null, pos: sel.pos, time, assist: sel.assist }).catch(e => { console.error(e); UI.toast('Could not start: ' + e.message); });
  }
  function goldenHour(a) {   // local hour ~1 h before sunset (from the sun position at the airport, sampled)
    const lat = a.lat * D, doy = (Date.now() / 864e5) % 365.25, decl = -23.44 * D * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
    const ha = Math.acos(clamp(-Math.tan(lat) * Math.tan(decl), -1, 1)) / D / 15; return 12 + ha - 0.9 - (a.lon - Math.round(a.lon / 15) * 15) / 15;
  }

  // ---------------------------------------------------------------- pause menu and crash card
  function menu(open) {
    if (!menuEl) {
      menuEl = document.createElement('div'); menuEl.className = 'fov'; menuEl.hidden = true;
      menuEl.innerHTML = `<div class="card panel" style="width:min(520px,92vw)"><div class="kicker">Paused</div><h2 id="fm-title">Flight</h2>
        <div style="display:grid;gap:8px"><button class="btn primary" data-a="resume">Resume</button><button class="btn" data-a="restart">Restart this flight</button><button class="btn" data-a="new">New flight…</button>
        <button class="btn" data-a="assist">Handling: <span id="fm-assist"></span></button><button class="btn" data-a="exit">Leave the aircraft (explore)</button></div>
        <p class="fnote">Keys: arrows pitch / roll · A / D rudder (steer on the ground) · W / S throttle (Shift: faster) · T reverse · F / R flaps · G gear · Space brakes · B parking brake · Z speed brakes · Y autopilot · U autothrottle · I approach (autoland) · [ ] heading · , . altitude · ; ' speed · C / 1-5 cameras · drag to look · wheel to zoom · X handling · Home / End trim (direct)</p></div>`;
      document.body.appendChild(menuEl);
      menuEl.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
        if (a === 'resume') menu(false); if (a === 'restart') { menu(false); Flight.restart(); } if (a === 'new') { menu(false); setup(true); } if (a === 'exit') { menu(false); Flight.stop(); }
        if (a === 'assist') { Flight.input.press('KeyX'); menuEl.querySelector('#fm-assist').textContent = Flight.fcs ? Flight.fcs.assist : ''; } });
    }
    menuEl.hidden = !open;
    if (open && Flight.type) { menuEl.querySelector('#fm-title').textContent = Flight.type.name; menuEl.querySelector('#fm-assist').textContent = { full: 'assisted', fbw: 'fly-by-wire', direct: 'direct' }[Flight.fcs.assist]; }
  }
  const menuOpen = () => !!menuEl && !menuEl.hidden || (!!setupEl && !setupEl.hidden);
  function crash(why, info) {
    if (!crashEl) {
      crashEl = document.createElement('div'); crashEl.className = 'fov'; crashEl.hidden = true;
      crashEl.innerHTML = `<div class="card panel" style="width:min(520px,92vw)"><div class="kicker" style="color:#ff5a4a">Crashed</div><h2 id="fc-why"></h2><p id="fc-info" style="color:var(--ink-dim)"></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-a="restart">Try again</button><button class="btn" data-a="new">New flight…</button><button class="btn" data-a="exit">Explore</button></div></div>`;
      document.body.appendChild(crashEl);
      crashEl.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (!b) return; crashEl.hidden = true; const a = b.dataset.a; if (a === 'restart') Flight.restart(); if (a === 'new') setup(true); if (a === 'exit') Flight.stop(); });
    }
    crashEl.querySelector('#fc-why').textContent = why; crashEl.querySelector('#fc-info').textContent = `Vertical speed ${Math.round(info.vs / FT * 60)} fpm, ground speed ${Math.round(info.gs / KT)} kt.`;
    setTimeout(() => { crashEl.hidden = false; }, 900);
  }

  // ---------------------------------------------------------------- touch controls
  function touchUi(on) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (!coarse) return;
    if (!touchEl) {
      touchEl = document.createElement('div'); touchEl.id = 'ftouch'; touchEl.hidden = true;
      touchEl.innerHTML = `<div class="stick"><i></i></div><div class="thr"><i></i></div><div class="btns"><button data-k="KeyG">GEAR</button><button data-k="KeyC">CAM</button><button data-k="KeyF">FLAP+</button><button data-k="KeyR">FLAP−</button><button data-k="Space" data-hold="1">BRAKE</button><button data-k="KeyI">APPR</button><button data-k="KeyY">AP</button><button data-k="Escape">☰</button></div>`;
      document.body.appendChild(touchEl);
      const st = touchEl.querySelector('.stick'), knob = st.firstElementChild; let sid = null;
      const move = (e) => { const r = st.getBoundingClientRect(); let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dy = (e.clientY - r.top - r.height / 2) / (r.height / 2); const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } knob.style.transform = `translate(${dx * 46}px,${dy * 46}px)`; Flight.input.touch.p = dy; Flight.input.touch.r = dx; Flight.input.touch.active = true; };
      st.addEventListener('pointerdown', (e) => { sid = e.pointerId; st.setPointerCapture(sid); move(e); });
      st.addEventListener('pointermove', (e) => { if (e.pointerId === sid) move(e); });
      const end = () => { sid = null; knob.style.transform = ''; Flight.input.touch.p = 0; Flight.input.touch.r = 0; Flight.input.touch.active = false; };
      st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
      const th = touchEl.querySelector('.thr'), tk = th.firstElementChild; let tid = null;
      const tmove = (e) => { const r = th.getBoundingClientRect(); const v = clamp(1 - (e.clientY - r.top - 13) / (r.height - 26), 0, 1); tk.style.top = ((1 - v) * (r.height - 26) + 0) + 'px'; Flight.input.touch.thr = v; };
      th.addEventListener('pointerdown', (e) => { tid = e.pointerId; th.setPointerCapture(tid); tmove(e); });
      th.addEventListener('pointermove', (e) => { if (e.pointerId === tid) tmove(e); });
      th.addEventListener('pointerup', () => { tid = null; Flight.input.touch.thr = null; });
      touchEl.querySelectorAll('.btns button').forEach(b => {
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); const k = b.dataset.k; if (k === 'Escape') { menu(!menuOpen()); return; } if (b.dataset.hold) Flight.input.keys.add(k); else Flight.input.press(k); });
        const up = () => { if (b.dataset.hold) Flight.input.keys.delete(b.dataset.k); }; b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up);
      });
    }
    touchEl.hidden = !on;
  }

  return { init, show, draw, note, setup, menu, menuOpen, crash, get shown() { return shown; } };
})();
