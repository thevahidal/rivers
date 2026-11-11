const RIVER_E = 0, RIVER_W = 1, RIVER_S = 2;
const STOP_N = 0, STOP_E = 1, STOP_W = 2, STOP_BAY = 3;

function bridgeEnd(state, cfg) {
  if (cfg.bridge) return state.k[1] === 0 ? STOP_E : STOP_W;
  return cfg.bay ? STOP_BAY : null;
}

function routeStop(river, state, cfg) {
  if (cfg.layout) return LAYOUTS[cfg.layout].route(river, state);
  const [a, b] = state.k;
  if (river === RIVER_E) return a === 0 ? STOP_N : bridgeEnd(state, cfg);
  if (river === RIVER_W) return a === 0 ? bridgeEnd(state, cfg) : STOP_N;
  return b === 0 ? STOP_W : STOP_E;
}

function newState(stage, cfg) {
  return {
    rivers: stage.rivers.map((river) => river.map(([c, n]) => [c, n])),
    lanes: stage.lanes.map((lane) => lane.map((bus) => ({ ...bus, key: cfg.unchain ? undefined : bus.key }))),
    stops: [0, 1, 2, 3].map(() => ({ bus: null, plat: [0, 0, 0, 0] })),
    k: [0, 0],
    uses: (cfg.tools || []).map((t) => t.uses),
    spent: [],
    queue: [],
    gone: [],
    moves: 0
  };
}

function clone(s) {
  return {
    rivers: s.rivers.map((river) => river.map(([c, n]) => [c, n])),
    lanes: s.lanes.map((lane) => lane.slice()),
    stops: s.stops.map((stop) => ({ bus: stop.bus && { ...stop.bus }, plat: stop.plat.slice() })),
    k: s.k.slice(),
    uses: (s.uses || []).slice(),
    spent: (s.spent || []).slice(),
    queue: (s.queue || []).map((bus) => ({ ...bus })),
    gone: s.gone.slice(),
    moves: s.moves
  };
}

const JOKER = 5;
const busSeats = (bus) => bus.n + (bus.n2 || 0);
const wantsColour = (bus) => (bus.fill < bus.n ? bus.c : bus.c2);
const isOpen = (s, cfg, i) => !(s.spent || []).includes(i) && !(cfg.closed || []).some(([stop, key]) => stop === i && !s.gone.includes(key));
const canSpin = (s, cfg, d) => !(cfg.locked || []).some(([disc, key]) => disc === d && !s.gone.includes(key));

const merged = (river) => river.reduce((out, [c, n]) => {
  const last = out[out.length - 1];
  if (last && last[0] === c) last[1] += n; else out.push([c, n]);
  return out;
}, []);
const canUse = (s, cfg, t) => {
  const tool = cfg.tools[t], river = s.rivers[tool.river];
  if (!(s.uses[t] > 0)) return false;
  if (tool.kind === 'loop') return river.length > 1;
  if (tool.kind === 'merge') return river.length > 0;
  return river.length > 0 && river[0][0] !== tool.c;
};

const platUsed = (stop) => stop.plat[0] + stop.plat[1] + stop.plat[2] + stop.plat[3];

function settle(s, cfg, events) {
  for (let changed = true; changed;) {
    changed = false;
    s.stops.forEach((stop, i) => {
      const bus = stop.bus;
      if (!bus) return;
      const n = Math.min(stop.plat[bus.c], bus.n - bus.fill);
      if (n > 0) {
        stop.plat[bus.c] -= n;
        bus.fill += n;
        events.push({ type: 'platform', stop: i, c: bus.c, n });
        changed = true;
      }
    });
    if (cfg.mix) s.stops.forEach((stop, i) => {
      const bus = stop.bus, [out, a, b] = cfg.mix;
      if (!bus || wantsColour(bus) !== out) return;
      const from = (c) => s.rivers.findIndex((river, r) => river[0] && river[0][0] === c && routeStop(r, s, cfg) === i);
      const ra = from(a), rb = from(b), room = Math.floor(((bus.fill < bus.n ? bus.n : busSeats(bus)) - bus.fill) / 2);
      if (ra < 0 || rb < 0 || room < 1) return;
      const n = Math.min(s.rivers[ra][0][1], s.rivers[rb][0][1], room);
      [ra, rb].forEach((r) => { s.rivers[r][0][1] -= n; if (!s.rivers[r][0][1]) s.rivers[r].shift(); });
      bus.fill += n * 2;
      events.push({ type: 'mix', stop: i, n });
      changed = true;
    });
    s.rivers.forEach((river, r) => {
      const front = river[0];
      if (!front) return;
      const i = routeStop(r, s, cfg);
      const bus = i === null ? null : s.stops[i].bus;
      if (!bus || bus.fill === busSeats(bus) || (wantsColour(bus) !== front[0] && front[0] !== JOKER)) return;
      const n = Math.min(front[1], (bus.fill < bus.n ? bus.n : busSeats(bus)) - bus.fill);
      front[1] -= n;
      bus.fill += n;
      if (front[1] === 0) river.shift();
      events.push({ type: 'flow', river: r, stop: i, c: front[0], n });
      changed = true;
    });
    s.stops.forEach((stop, i) => {
      const bus = stop.bus;
      if (!bus || bus.fill < busSeats(bus) || (cfg.layout && LAYOUTS[cfg.layout].train)) return;
      stop.bus = null;
      s.gone.push(bus.id);
      if ((cfg.once || []).includes(i)) s.spent.push(i);
      events.push({ type: 'depart', stop: i, bus });
      if (bus.transfer) {
        s.rivers[RIVER_S].push([bus.c, bus.n]);
        events.push({ type: 'transfer', c: bus.c, n: bus.n });
      }
      changed = true;
    });
  }
}

const canCall = (s, lane) => {
  const bus = s.lanes[lane][0];
  return !!bus && (bus.key === undefined || s.gone.includes(bus.key));
};

function legalMoves(s, cfg) {
  const moves = [['spin', 0], ['spin', 1]];
  s.rivers.forEach((river, r) => {
    const front = river[0], i = routeStop(r, s, cfg);
    if (!front || i === null) return;
    if (cfg.caps[i] - platUsed(s.stops[i]) >= front[1]) moves.push(['shunt', r]);
  });
  s.lanes.forEach((_, lane) => {
    if (!canCall(s, lane)) return;
    const stopCount = cfg.bay ? 4 : 3;
    for (let i = 0; i < stopCount; i++) if (!s.stops[i].bus) moves.push(['call', lane, i]);
  });
  return moves;
}

function apply(s, cfg, move) {
  const next = clone(s), events = [];
  const layout = cfg.layout && LAYOUTS[cfg.layout];
  if (move[0] === 'spin' && layout && layout.train) {
    const last = layout.stops - 1, out = next.stops[last].bus;
    if (out) next.gone.push(out.id);
    for (let i = last; i > 0; i--) next.stops[i].bus = next.stops[i - 1].bus;
    next.stops[0].bus = next.queue.shift() || null;
    next.k[0]++;
    events.push({ type: 'advance' });
  } else if (move[0] === 'spin') {
    const turns = (layout && layout.turns) || 2;
    if (layout && layout.swap && move[1] === 2) [next.k[0], next.k[1]] = [next.k[1], next.k[0]];
    [move[1], ...((cfg.gears && cfg.gears[move[1]]) || [])].forEach((d) => { next.k[d] = (next.k[d] + 1) % turns; });
    events.push({ type: 'spin', disc: move[1] });
  } else if (move[0] === 'tool') {
    const tool = cfg.tools[move[1]], river = next.rivers[tool.river];
    if (tool.kind === 'merge') {
      next.rivers[tool.into] = merged(next.rivers[tool.into].concat(river));
      next.rivers[tool.river] = [];
    } else {
      const front = river.shift();
      if (tool.kind === 'loop') river.push(front); else river.unshift([tool.c, front[1]]);
      next.rivers[tool.river] = merged(river);
    }
    next.uses[move[1]]--;
    events.push({ type: 'tool', tool: move[1] });
  } else if (move[0] === 'shunt') {
    const r = move[1], i = routeStop(r, next, cfg), [c, n] = next.rivers[r].shift();
    next.stops[i].plat[c] += n;
    events.push({ type: 'shunt', river: r, stop: i, c, n });
  } else if (move[2] === 'q') {
    next.queue.push({ ...next.lanes[move[1]].shift(), fill: 0 });
    events.push({ type: 'call', lane: move[1], stop: 'q' });
  } else {
    const bus = next.lanes[move[1]].shift();
    next.stops[move[2]].bus = { ...bus, fill: 0 };
    events.push({ type: 'call', lane: move[1], stop: move[2], bus });
  }
  next.moves++;
  settle(next, cfg, events);
  return { state: next, events };
}

const isWon = (s) => s.rivers.every((r) => !r.length) && s.lanes.every((l) => !l.length) && !(s.queue || []).length && s.stops.every((st) => (!st.bus || st.bus.fill === busSeats(st.bus)) && !platUsed(st));

function isJammed(s, cfg) {
  if (isWon(s)) return false;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    const t = clone(s);
    t.k = [a, b];
    const events = [];
    settle(t, cfg, events);
    if (events.length) return false;
    if (legalMoves(t, cfg).some((m) => m[0] !== 'spin')) return false;
  }
  return true;
}

const LAYOUTS = {
  road: { stops: 1, discs: 0, reach: [[0]], route: () => 0 },
  fork: {
    stops: 2, discs: 0, reach: [[0, 1]],
    route: (r, s) => {
      const c = s.rivers[r][0] && s.rivers[r][0][0];
      const i = [0, 1].find((j) => s.stops[j].bus && wantsColour(s.stops[j].bus) === c && s.stops[j].bus.fill < busSeats(s.stops[j].bus));
      return i === undefined ? 0 : i;
    }
  },
  one: { stops: 2, discs: 1, reach: [[0, 1], [0, 1]], route: (r, s) => ((r === 0) === (s.k[0] === 0) ? 0 : 1) },
  twin: { stops: 3, discs: 2, reach: [[0, 1, 2], [0, 1, 2], [1, 2]], route: (r, s) => routeStop(r, s, { bridge: true }) },
  triple: {
    stops: 4, discs: 3, reach: [[0, 1, 2], [0, 1, 2], [3, 1, 2], [3, 1, 2]],
    route: (r, s) => {
      const [a, b, c] = s.k;
      if (r < 2) return (r === 0) === (a === 0) ? 0 : (b === 0 ? 1 : 2);
      return (r === 2) === (c === 0) ? (b === 0 ? 2 : 1) : 3;
    }
  },
  cross: { stops: 2, discs: 1, reach: [[0, 1], [0, 1]], route: (r, s) => ((r === 0) === (s.k[0] === 0) ? 0 : 1) },
  carousel: {
    stops: 4, discs: 1, turns: 4, reach: [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]],
    route: (r, s) => (r + 1 - (s.k[0] % 4) + 4) % 4,
    entry: (s) => (4 - (s.k[0] % 4)) % 4
  },
  train: { stops: 3, discs: 1, train: true, slots: 2, reach: [[0], [1], [2]], route: (r) => r },
  slide: { stops: 2, discs: 1, reach: [[0], [0, 1], [1]], route: (r, s) => (r - s.k[0] === 0 || r - s.k[0] === 1 ? r - s.k[0] : null) }
};

const GRID = {
  links: { '0:1': [1, 3], '1:3': [0, 1], '0:2': [2, 0], '2:0': [0, 2], '2:1': [3, 3], '3:3': [2, 1], '1:2': [3, 0], '3:0': [1, 2] },
  exits: { '0:0': 0, '1:0': 1, '2:2': 2, '3:2': 3 },
  entries: [[0, 3], [1, 1], [2, 3], [3, 1]]
};
const RING = {
  links: { '0:1': [1, 3], '1:3': [0, 1] },
  exits: { '0:0': 0, '1:0': 1, '1:2': 2 },
  entries: [[0, 3], [1, 1], [0, 2]]
};
function walk(topo, r, k) {
  let [disc, port] = topo.entries[r];
  for (let guard = 0; guard < 6; guard++) {
    const turn = k[disc] % 2, local = (port - turn + 4) % 4, out = ((local < 2 ? 1 - local : 5 - local) + turn) % 4, key = disc + ':' + out;
    if (topo.exits[key] !== undefined) return topo.exits[key];
    if (!topo.links[key]) return null;
    [disc, port] = topo.links[key];
  }
  return null;
}
const reachOf = (topo, discs) => topo.entries.map((_, r) => [...new Set(Array.from({ length: 1 << discs }, (_, m) => walk(topo, r, Array.from({ length: discs }, (_, d) => (m >> d) & 1))).filter((i) => i !== null))]);
LAYOUTS.grid = { stops: 4, discs: 4, route: (r, s) => walk(GRID, r, s.k), reach: reachOf(GRID, 4) };
LAYOUTS.ring = { stops: 3, discs: 3, swap: true, route: (r, s) => walk(RING, r, s.k), reach: reachOf(RING, 2) };
LAYOUTS.tunnel = { stops: 3, discs: 1, turns: 3, reach: [[0, 1, 2], [0, 1, 2], [0, 1, 2]], route: (r, s) => (r + s.k[0]) % 3 };
LAYOUTS.mix = { stops: 1, discs: 0, reach: [[0], [0]], route: () => 0 };

function allowedStops(s, bus, cfg) {
  const layout = LAYOUTS[cfg.layout];
  const stops = Array.from({ length: layout.stops }, (_, i) => i).filter((i) => !s.stops[i].bus && isOpen(s, cfg, i) && (!layout.entry || layout.entry(s) === i));
  const supply = (i, colour) => s.rivers.reduce((sum, river, r) => (layout.reach[r] && layout.reach[r].includes(i) ? sum + river.reduce((n, [c, k]) => (c === colour ? n + k : n), 0) : sum), 0);
  const have = (i, c) => supply(i, c) + supply(i, JOKER) + (cfg.mix && c === cfg.mix[0] ? 2 * Math.min(supply(i, cfg.mix[1]), supply(i, cfg.mix[2])) : 0);
  return stops.filter((i) => have(i, bus.c) >= bus.n && (!bus.n2 || have(i, bus.c2) >= bus.n2));
}

function flowMoves(s, cfg) {
  const out = [], layout = LAYOUTS[cfg.layout];
  if (layout.train) {
    if (s.queue.length < layout.slots) s.lanes.forEach((lane, l) => { if (lane[0] && canCall(s, l)) out.push(['call', l, 'q']); });
    if (s.queue.length || s.stops.some((st) => st.bus)) out.push(['spin', 0]);
    return out;
  }
  for (let d = 0; d < LAYOUTS[cfg.layout].discs; d++) if (canSpin(s, cfg, d)) out.push(['spin', d]);
  s.lanes.forEach((lane, l) => {
    if (lane[0] && canCall(s, l)) allowedStops(s, lane[0], cfg).forEach((i) => out.push(['call', l, i]));
  });
  (cfg.tools || []).forEach((_, t) => { if (canUse(s, cfg, t)) out.push(['tool', t]); });
  return out;
}

if (typeof module !== 'undefined') module.exports = { RIVER_E, RIVER_W, RIVER_S, STOP_N, STOP_E, STOP_W, STOP_BAY, routeStop, newState, clone, platUsed, settle, canCall, legalMoves, apply, isWon, isJammed, LAYOUTS, allowedStops, flowMoves, busSeats, wantsColour, isOpen, canSpin, canUse, JOKER, RING };
