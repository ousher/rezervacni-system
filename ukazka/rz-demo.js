/*
 * UKÁZKA — server rezervací běžící v prohlížeči.
 * Nahrazuje dostupnost.php, odeslat.php a obsluha/api.php tak, aby se dalo všechno
 * proklikat bez hostingu. Data leží jen v tomto prohlížeči (localStorage) a nikam se neposílají.
 *
 * 🔴 Pravidla (stoly, otevírací doba, délka sezení…) sem NEPÍŠE člověk: build.py je vytáhne
 * z app/nastaveni.inc.php a vloží do CFG. Logika níž je převod jadro.inc.php 1:1 —
 * a obě verze projdou tutéž sadou scénářů (test/scenare.json).
 */
(function () {
  'use strict';
  const CFG = {"DAYS_AHEAD": 30, "SLOT": 30, "SIT_MIN": 120, "LAST_SEAT": 90, "LEAD_MIN": 60, "MAX_PARTY": 8, "VENUE": {"name": "Restaurace Na Ukázku", "address": "Ukázková 1, Praha 11", "phone": "+420 000 000 000", "web": "/", "brand": ""}, "TABLES": {"T1": ["Stůl 1 · okno", 2, true], "T2": ["Stůl 2 · okno", 2, true], "T3": ["Stůl 3", 4, true], "T4": ["Stůl 4", 4, true], "T5": ["Stůl 5", 4, true], "T6": ["Stůl 6 · box", 6, true], "T7": ["Stůl 7 · salonek", 8, true], "T8": ["Bar · vysoký stůl", 4, false]}, "HOURS": {"1": [660, 1320], "2": [660, 1320], "3": [660, 1320], "4": [660, 1380], "5": [660, 1440], "6": [720, 1440], "0": [720, 1320]}, "LANE_GROUPS": {}, "SEED_LANES": [], "DEMO_LABEL": "podnik je vymyšlený"};
  const DEMO_PIN = '1234';
  const KEY = 'rz_demo_v1';
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = m => `${pad(m === 1440 ? 24 : Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ── úložiště ──
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return s; } catch (e) {}
    return seed();
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  let S = null;
  const db = () => (S = S || load());
  function prune(s) {                                   // dny před dneškem pryč (jako na serveru)
    const t = today();
    s.claims = s.claims.filter(c => c.d >= t);
    for (const r of Object.keys(s.det)) if (s.det[r].d < t) delete s.det[r];
  }
  const commit = () => { prune(S); save(S); };

  // ── čas ──
  const today = () => iso(new Date());
  const dayObj = date => { const d = new Date(date + 'T12:00:00'); return isNaN(d) || iso(d) !== date ? null : d; };
  function inWindow(date) {
    const d = dayObj(date); if (!d) return null;
    const diff = Math.round((d - new Date(today() + 'T12:00:00')) / 864e5);
    return diff < 0 || diff >= CFG.DAYS_AHEAD ? null : d;
  }
  const hours = d => CFG.HOURS[d.getDay()] || null;
  const nowMin = date => { const n = new Date(); return iso(n) === date ? n.getHours() * 60 + n.getMinutes() : null; };
  function times(date, lead) {
    const d = inWindow(date); if (!d) return [];
    const h = hours(d); if (!h) return [];
    const now = nowMin(date);
    const min = now === null ? 0 : (lead ? now + CFG.LEAD_MIN : now - CFG.SLOT);
    const out = [];
    for (let t = h[0]; t <= h[1] - CFG.LAST_SEAT; t += CFG.SLOT) if (t >= min) out.push(t);
    return out;
  }
  function span(date, t) { const d = dayObj(date), h = d && hours(d); return [t, Math.min(t + CFG.SIT_MIN, h ? h[1] : 1440)]; }

  // ── stoly ──
  const TB = Object.entries(CFG.TABLES).map(([id, [n, cap, online]]) => ({ id, n, cap, online }));
  function pick(claims, date, t, p, online) {
    const [a, b] = span(date, t);
    const free = TB.filter(tb => tb.cap >= p && !(online && !tb.online) &&
      !claims.some(c => c.d === date && c.s === tb.id && a < c.b && c.a < b));
    if (!free.length) return null;
    return free.reduce((m, x) => (x.cap < m.cap ? x : m)).id;       // nejmenší; při shodě první v pořadí
  }
  function claim(date, t, p, base, online, table, suffix) {
    const s = db();
    if (table == null) table = pick(s.claims, date, t, p, online);
    else { const [a, b] = span(date, t); if (s.claims.some(c => c.d === date && c.s === table && a < c.b && c.a < b)) table = null; }
    if (table == null) return ['busy'];
    const [a, b] = span(date, t);
    let ref = `${base}-${table}${suffix || ''}`;
    for (let n = 2; s.claims.some(c => c.r === ref); n++) ref = `${base}-${table}-${n}${suffix || ''}`;   // D223 audit: po přesunu stolu stejné číslo = přepis cizího hosta
    s.claims.push({ d: date, s: table, a, b, p, r: ref, c: nowSec() });
    commit();
    return ['ok', table, ref];
  }

  // ── dráhy na čas (převod rz_lane_* z jadro.inc.php) ──
  const GR = CFG.LANE_GROUPS || {};
  const gHours = (G, d) => (G.hours ? G.hours[d.getDay()] : hours(d)) || null;   // vlastní doba skupiny (stěna 9–22)
  const units = (G, p) => Math.max(1, Math.ceil(p / Math.max(1, G.per)));
  const durOk = (G, dur) => dur >= G.min && dur <= G.max && (dur - G.min) % G.step === 0;
  function laneTimes(date, G, dur, lead) {
    const d = inWindow(date); if (!d) return [];
    const h = gHours(G, d); if (!h) return [];
    const now = nowMin(date), min = now === null ? 0 : (lead ? now + CFG.LEAD_MIN : now - G.step), out = [];
    for (let t = h[0]; t + dur <= h[1]; t += G.step) if (t >= min) out.push(t);
    return out;
  }
  function lanePick(claims, date, t, dur, G, n) {
    const free = [];
    for (const id of Object.keys(G.items)) {
      if (claims.some(c => c.d === date && c.s === id && t < c.b && c.a < t + dur)) continue;
      free.push(id); if (free.length === n) return free;
    }
    return null;
  }
  function laneClaim(date, t, dur, g, p, base, suffix) {
    const s = db(), G = GR[g], lanes = lanePick(s.claims, date, t, dur, G, units(G, p));
    if (!lanes) return ['busy'];
    const ref = `${base}-${lanes.join('+')}${suffix || ''}`;
    for (const id of lanes) s.claims.push({ d: date, s: id, a: t, b: t + dur, p, g, r: ref, c: nowSec() });
    commit(); return ['ok', lanes, ref];
  }
  function byRef(claims) {
    const o = {}, out = [];
    for (const c of claims) { if (o[c.r]) { o[c.r].s += '+' + c.s; continue; } o[c.r] = Object.assign({}, c); out.push(o[c.r]); }
    return out;
  }
  const groupsOut = () => Object.entries(GR).map(([id, G]) => ({ id, label: G.label, unit: G.unit, per: G.per, min: G.min, max: G.max,
    step: G.step, maxUnits: G.maxUnits, count: Object.keys(G.items).length, hours: G.hours || CFG.HOURS, people: G.people || null, askP: G.askP || null, askDur: G.askDur || null, note: G.note || null, items: Object.entries(G.items).map(([i, n]) => ({ id: i, n })) }));

  // ── ukázková data: ať panel nevypadá prázdný ──
  function seed() {
    const s = { v: 1, claims: [], det: {}, authed: false };
    S = s;
    const plan = [
      [0, '12:00', 4, 'Pavel Dvořák', '+420 601 111 222', '', 'web', 'arrived'],
      [0, '12:30', 2, 'Eva Malá', '+420 602 333 444', '', 'phone', 'arrived'],
      [0, '18:00', 6, 'Tomáš Kratochvíl', '+420 603 555 666', 'narozeniny — dort si přinesou', 'web'],
      [0, '18:30', 2, 'Lucie Horká', '+420 604 777 888', '', 'web'],
      [0, '19:00', 8, 'Firma Alfa s.r.o.', '+420 605 999 000', 'firemní večeře, faktura', 'phone'],
      [0, '19:30', 3, 'Martin Svoboda', '+420 606 121 212', 'dětská židlička', 'web'],
      [1, '18:00', 4, 'Jana Veselá', '+420 607 343 434', '', 'web'],
      [1, '19:00', 2, 'Petr Černý', '+420 608 565 656', '', 'phone'],
    ];
    for (const [off, tm, p, n, ph, note, via, st] of plan) {
      const d = new Date(); d.setDate(d.getDate() + off);
      const date = iso(d), t = +tm.slice(0, 2) * 60 + +tm.slice(3);
      if (!hours(d) || t < hours(d)[0] || t > hours(d)[1] - CFG.LAST_SEAT) continue;   // jen v otevírací době
      const r = claim(date, t, p, `R${date.replace(/-/g, '')}-${tm.replace(':', '')}`, via === 'web', null, via === 'phone' ? '-T' : '');
      if (r[0] !== 'ok') continue;
      s.claims[s.claims.length - 1].c = nowSec() - 86400;          // „staré“, aby nesvítily jako nové
      s.det[r[2]] = { r: r[2], d: date, a: t, p, n, ph, em: '', note, z: via === 'phone' ? 'tel' : '', via, st: (st && off === 0 && nowMin(date) !== null && nowMin(date) >= t + 30) ? st : 'new', c: nowSec() - 86400 };   // „přišli“ jen u toho, co už proběhlo
    }
    for (const [off, tm, g, p, dur, n, ph, note, via] of (CFG.SEED_LANES || [])) {
      const d = new Date(); d.setDate(d.getDate() + off);
      const date = iso(d), t = +tm.slice(0, 2) * 60 + +tm.slice(3);
      if (!GR[g] || !gHours(GR[g], d) || t + dur > gHours(GR[g], d)[1]) continue;
      const r = laneClaim(date, t, dur, g, p, `R${date.replace(/-/g, '')}-${tm.replace(':', '')}`, via === 'phone' ? '-T' : '');
      if (r[0] !== 'ok') continue;
      s.claims.filter(c => c.r === r[2]).forEach(c => { c.c = nowSec() - 86400; });
      s.det[r[2]] = { r: r[2], d: date, a: t, p, g, dur, n, ph, em: '', note, z: via === 'phone' ? 'tel' : '', via, st: 'new', c: nowSec() - 86400 };
    }
    save(s);
    return s;
  }

  // ── odpovědi ──
  const J = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });
  const fail = (code, error) => J(code, { ok: false, error });
  const ok = (o) => J(200, Object.assign({ ok: true }, o || {}));
  const osob = p => (p === 1 ? 'osobu' : p < 5 ? 'osoby' : 'osob');

  function dostupnost(q) {
    if (q.has('info')) return ok({ venue: CFG.VENUE, daysAhead: CFG.DAYS_AHEAD, maxParty: CFG.MAX_PARTY, sit: CFG.SIT_MIN, hours: CFG.HOURS, today: today(),
      tables: Object.keys(CFG.TABLES).length > 0, groups: groupsOut().map(({ items, ...g }) => g) });
    if (q.has('g')) {
      const G = GR[q.get('g')], date = q.get('date') || '', p = parseInt(q.get('p') || '0', 10), dur = parseInt(q.get('dur') || '0', 10);
      if (!G) return fail(400, 'Neznámá nabídka.');
      if (!inWindow(date)) return fail(400, 'Datum mimo rezervační okno.');
      if (!(p >= 1 && p <= G.per * G.maxUnits)) return fail(400, 'Neplatný počet hráčů.');
      if (!durOk(G, dur)) return fail(400, 'Neplatná délka.');
      const cl = db().claims, n = units(G, p);
      return ok({ date, p, units: n, times: laneTimes(date, G, dur, true).map(t => [hhmm(t), lanePick(cl, date, t, dur, G, n) !== null]) });
    }
    const date = q.get('date') || '', p = parseInt(q.get('p') || '0', 10);
    if (!inWindow(date)) return fail(400, 'Datum mimo rezervační okno.');
    if (!(p >= 1 && p <= CFG.MAX_PARTY)) return fail(400, 'Neplatný počet osob.');
    const cl = db().claims;
    return ok({ date, p, times: times(date, true).map(t => [hhmm(t), pick(cl, date, t, p, true) !== null]) });
  }

  function odeslat(f) {
    if ((f.get('web') || '') !== '') return ok({ ref: '—' });
    if ((parseInt(f.get('t') || '0', 10)) < 4) return fail(400, 'Formulář byl odeslán příliš rychle, zkuste to prosím znovu.');
    const date = f.get('date') || '', d = inWindow(date);
    if (!d) return fail(400, 'Datum mimo rezervační okno.');
    const p = parseInt(f.get('p') || '0', 10), g = f.get('g') || '', G = g ? GR[g] : null, dur = parseInt(f.get('dur') || '0', 10);
    if (g && !G) return fail(400, 'Neznámá nabídka.');
    const m = /^(\d{2}):(\d{2})$/.exec(f.get('time') || ''); if (!m) return fail(400, 'Neplatný čas.');
    const t = +m[1] * 60 + +m[2];
    if (G) {
      if (!(p >= 1)) return fail(400, 'Neplatný počet hráčů.');
      if (p > G.per * G.maxUnits) return fail(400, `Pro víc než ${G.per * G.maxUnits} hráčů nám prosím zavolejte na ${CFG.VENUE.phone}.`);
      if (!durOk(G, dur)) return fail(400, 'Neplatná délka.');
      if (!laneTimes(date, G, dur, true).includes(t)) return fail(400, 'Na tento čas už rezervovat nejde.');
    } else {
      if (!Object.keys(CFG.TABLES).length) return fail(400, 'Stoly se tu online nerezervují.');
      if (!(p >= 1)) return fail(400, 'Neplatný počet osob.');
      if (p > CFG.MAX_PARTY) return fail(400, `Pro víc než ${CFG.MAX_PARTY} osob nám prosím zavolejte na ${CFG.VENUE.phone}.`);
      if (!times(date, true).includes(t)) return fail(400, 'Na tento čas už rezervovat nejde.');
    }
    const name = (f.get('name') || '').trim().slice(0, 80), phone = (f.get('phone') || '').trim().slice(0, 30);
    const email = (f.get('email') || '').trim().slice(0, 120), note = (f.get('note') || '').trim().slice(0, 200);
    if (!name) return fail(400, 'Chybí jméno.');
    if (!/^\+?[0-9 ()\-]{6,20}$/.test(phone)) return fail(400, 'Doplňte prosím platný telefon.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'E-mail vypadá neplatně.');
    const base = `R${date.replace(/-/g, '')}-${hhmm(t).replace(':', '')}`;
    const c = G ? laneClaim(date, t, dur, g, p, base, '') : claim(date, t, p, base, true, null, '');
    if (c[0] === 'busy') return fail(409, G ? `Na tento čas už nemáme volných ${units(G, p)}× ${G.unit}. Vyberte prosím jiný.` : `Na tento čas už pro ${p} ${osob(p)} nemáme volný stůl. Vyberte prosím jiný.`);
    db().det[c[2]] = { r: c[2], d: date, a: t, p, g, dur: G ? dur : null, n: name, ph: phone, em: email, note, z: (f.get('z') || ''), via: 'web', st: 'new', c: nowSec() };
    commit();
    if (email) mailDemo({ email, date, time: hhmm(t), p, g, dur: G ? dur : '' });   // D224 (Andrej): ukázkové potvrzení na zadaný e-mail
    return ok({ ref: c[2], time: hhmm(t), p, g, units: G ? c[1].length : null });
  }

  function row(c, x) {
    x = x || {};
    return { r: c.r, s: c.s, g: c.g || x.g || '', a: c.a, b: c.b, p: c.p ?? x.p ?? 0, st: x.st || 'new', via: x.via || 'web', n: x.n || '', ph: x.ph || '',
      em: x.em || '', note: x.note || '', z: x.z || '', c: c.c || 0 };
  }

  function api(q, f, post) {
    const a = q.get('a') || '', s = db();
    if (a === 'me') return ok({ authed: !!s.authed, pinSet: true, venue: CFG.VENUE.name, demoPin: DEMO_PIN });
    if (a === 'login' && post) {
      if ((f.get('pin') || '') !== DEMO_PIN) return fail(401, 'Špatný PIN. (V ukázce je PIN ' + DEMO_PIN + '.)');
      s.authed = true; commit(); return ok();
    }
    if (a === 'logout' && post) { s.authed = false; commit(); return ok(); }
    if (!s.authed) return fail(401, 'Přihlaste se PINem.');
    if (a === 'day') {
      const date = q.get('date') || '', d = dayObj(date); if (!d) return fail(400, 'Neplatné datum.');
      const h = hours(d), det = Object.assign({}, ...Object.values(s.det).filter(x => x.d === date).map(x => ({ [x.r]: x })));
      const items = [];
      for (const c of byRef(s.claims.filter(c => c.d === date))) { items.push(row(c, det[c.r])); delete det[c.r]; }
      for (const x of Object.values(det)) if (x.st === 'cancelled') items.push(row({ r: x.r, s: x.s0 || '', a: x.a, b: x.a + (x.dur || CFG.SIT_MIN), p: x.p, c: x.c }, x));
      items.sort((p, q2) => p.a - q2.a || (p.s > q2.s ? 1 : -1));
      return ok({ date, open: h ? h[0] : null, close: h ? h[1] : null, tables: TB, groups: groupsOut(), items, times: times(date, false),
        sit: CFG.SIT_MIN, maxParty: CFG.MAX_PARTY, now: nowSec() });
    }
    if (a === 'new') {
      const since = parseInt(q.get('since') || '0', 10);
      const items = byRef(s.claims).filter(c => !c.r.endsWith('-T') && (c.c || 0) > since)
        .map(c => ({ r: c.r, d: c.d, s: c.s, g: c.g || '', a: c.a, p: c.p, c: c.c })).sort((x, y) => x.c - y.c);
      return ok({ items, now: nowSec() });
    }
    if (!post) return fail(405, 'Neznámá akce.');
    const ref = f.get('ref') || '';
    if (a === 'status') {
      const st = f.get('st'); if (!['new', 'arrived', 'noshow'].includes(st)) return fail(400, 'Neplatný stav.');
      if (!s.det[ref]) return fail(404, 'Rezervace nenalezena.');
      s.det[ref].st = st; commit(); return ok();
    }
    if (a === 'cancel') {
      const s0 = s.claims.filter(c => c.r === ref).map(c => c.s).join('+');
      s.claims = s.claims.filter(c => c.r !== ref);
      if (s.det[ref]) { s.det[ref].st = 'cancelled'; s.det[ref].s0 = s0; }
      commit(); return ok();
    }
    if (a === 'move') {
      const table = f.get('table'); if (!CFG.TABLES[table]) return fail(400, 'Neplatný stůl.');
      const me = s.claims.find(c => c.r === ref); if (!me) return fail(404, 'Rezervace nenalezena.');
      if (me.g) return fail(400, 'Dráhy se nepřesouvají — rezervaci zrušte a zapište znovu.');
      if (s.claims.some(c => c !== me && c.d === me.d && c.s === table && me.a < c.b && c.a < me.b)) return fail(409, 'Ten stůl je v tu dobu obsazený.');
      me.s = table; commit(); return ok();
    }
    if (a === 'add') {
      const date = f.get('date') || '', d = dayObj(date); if (!d) return fail(400, 'Neplatné datum.');
      if (!inWindow(date)) return fail(400, 'Datum mimo rezervační okno.');
      const m = /^(\d{2}):(\d{2})$/.exec(f.get('time') || ''); if (!m) return fail(400, 'Neplatný čas.');
      const t = +m[1] * 60 + +m[2], h = hours(d), g = f.get('g') || '';
      if (g) {
        const G = GR[g]; if (!G) return fail(400, 'Neznámá nabídka.');
        const dur = parseInt(f.get('dur') || '0', 10); if (!durOk(G, dur)) return fail(400, 'Neplatná délka.');
        const gh = gHours(G, d);
        if (!gh || t % G.step || t < gh[0] || t + dur > gh[1]) return fail(400, 'Čas je mimo otevírací dobu.');
        const p = parseInt(f.get('p') || '0', 10); if (!(p >= 1 && p <= G.per * Object.keys(G.items).length)) return fail(400, 'Neplatný počet hráčů.');
        const name = (f.get('name') || '').trim().slice(0, 80); if (!name) return fail(400, 'Chybí jméno.');
        const c = laneClaim(date, t, dur, g, p, `R${date.replace(/-/g, '')}-${hhmm(t).replace(':', '')}`, '-T');
        if (c[0] === 'busy') return fail(409, 'V tu dobu není volných dost drah.');
        s.det[c[2]] = { r: c[2], d: date, a: t, p, g, dur, n: name, ph: (f.get('phone') || '').trim(), em: '', note: (f.get('note') || '').trim(), z: 'tel', via: 'phone', st: 'new', c: nowSec() };
        commit(); return ok({ ref: c[2], table: c[1].join('+') });
      }
      if (!h || t % CFG.SLOT || t < h[0] || t >= h[1]) return fail(400, 'Čas je mimo otevírací dobu.');
      const p = parseInt(f.get('p') || '0', 10); if (!(p >= 1 && p <= 40)) return fail(400, 'Neplatný počet osob.');
      const table = f.get('table') || ''; if (table && !CFG.TABLES[table]) return fail(400, 'Neplatný stůl.');
      const name = (f.get('name') || '').trim().slice(0, 80); if (!name) return fail(400, 'Chybí jméno.');
      const c = claim(date, t, p, `R${date.replace(/-/g, '')}-${hhmm(t).replace(':', '')}`, false, table || null, '-T');
      if (c[0] === 'busy') return fail(409, table ? 'Ten stůl je v tu dobu obsazený.' : 'Pro tolik osob není v tu dobu volný stůl.');
      s.det[c[2]] = { r: c[2], d: date, a: t, p, n: name, ph: (f.get('phone') || '').trim(), em: '', note: (f.get('note') || '').trim(), z: 'tel', via: 'phone', st: 'new', c: nowSec() };
      commit(); return ok({ ref: c[2], table: c[1] });
    }
    return fail(400, 'Neznámá akce.');
  }

  // ── napojení na fetch ──
  const realFetch = window.fetch.bind(window);

  // Ukázkové potvrzení e-mailem (D224). Jen na veřejném webu — lokální testy a dema na míru nic neposílají.
  // Server pošle PEVNÝ text (datum, čas, počet, druh); jméno ani poznámka ven nejdou. Limity hlídá server.
  const MAILER = 'https://rezervace-mailer.tia-hydra.workers.dev/potvrzeni';
  function mailDemo(d) {
    if (!/(^|\.)rezervacni-system\.online$/.test(location.hostname)) return;
    const note = (txt) => setTimeout(() => { const b = document.getElementById('done'); if (b) b.insertAdjacentHTML('beforeend', '<div style="margin-top:8px;font-size:14px;opacity:.8">' + txt + '</div>'); }, 400);
    realFetch(MAILER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(r => note(r.ok ? '📧 Ukázkové potvrzení jsme poslali na váš e-mail.' : r.status === 429 ? '📧 Na tuto adresu už dnes ukázkové potvrzení odešlo.' : '📧 Ukázkové potvrzení se teď nepodařilo odeslat.'))
      .catch(() => note('📧 Ukázkové potvrzení se teď nepodařilo odeslat.'));
  }
  window.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const post = ((init && init.method) || 'GET').toUpperCase() === 'POST';
    const f = new URLSearchParams(init && init.body ? String(init.body) : '');
    await new Promise(r => setTimeout(r, 120));          // ať to působí jako síť
    S = null;   // D223 (Smith): vždy čerstvý stav z úložiště — druhé okno (host/obsluha) jinak nevidí nové rezervace a přepíše je
    if (/dostupnost\.php$/.test(url.pathname)) return dostupnost(url.searchParams);
    if (/odeslat\.php$/.test(url.pathname)) return post ? odeslat(f) : fail(405, 'Jen odeslání formuláře.');
    if (/api\.php$/.test(url.pathname)) return api(url.searchParams, f, post);
    return realFetch(input, init);
  };

  // ── pruh „UKÁZKA“ + reset ──
  window.addEventListener('storage', e => { if (e.key === KEY) S = null; });   // změna z druhého okna
  window.RZ_DEMO_RESET = () => { try { localStorage.removeItem(KEY); } catch (e) {} S = null; location.reload(); };
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.style.cssText = 'position:relative;z-index:1;background:#e7b552;color:#241a05;font:600 13px/1.35 system-ui,sans-serif;padding:7px 12px;text-align:center';
    b.innerHTML = 'UKÁZKA · ' + (CFG.DEMO_LABEL || 'podnik je vymyšlený') + ' · nic se neodesílá, data zůstávají jen v tomto prohlížeči · '
      + '<a href="' + (location.pathname.includes('/obsluha/') ? '../' : './') + 'start.html" style="color:inherit">přepnout host / obsluha</a> · '
      + '<a href="#" onclick="RZ_DEMO_RESET();return false" style="color:inherit">začít znovu</a>'
      + ' · <a href="https://rezervacni-system.online/#kontakt" target="_top" style="color:inherit;font-weight:800">chci to u sebe →</a>';   // D224 Smith: cesta k poptávce z obou obrazovek
    document.body.prepend(b);
  });
  window.RZ_DEMO = { CFG, db: () => db(), pick, times, span };
})();
