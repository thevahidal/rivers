const RIVER_E = 0, RIVER_W = 1, RIVER_S = 2;
const STOP_N = 0, STOP_E = 1, STOP_W = 2, STOP_BAY = 3;

function bridgeEnd(state, cfg) {
  if (cfg.bridge) return state.k[1] === 0 ? STOP_E : STOP_W;
  return cfg.bay ? STOP_BAY : null;
}

function routeStop(river, state, cfg) {
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
    gone: s.gone.slice(),
    moves: s.moves
  };
}

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
    s.rivers.forEach((river, r) => {
      const front = river[0];
      if (!front) return;
      const i = routeStop(r, s, cfg);
      const bus = i === null ? null : s.stops[i].bus;
      if (!bus || bus.c !== front[0] || bus.fill === bus.n) return;
      const n = Math.min(front[1], bus.n - bus.fill);
      front[1] -= n;
      bus.fill += n;
      if (front[1] === 0) river.shift();
      events.push({ type: 'flow', river: r, stop: i, c: bus.c, n });
      changed = true;
    });
    s.stops.forEach((stop, i) => {
      const bus = stop.bus;
      if (!bus || bus.fill < bus.n) return;
      stop.bus = null;
      s.gone.push(bus.id);
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
  if (move[0] === 'spin') {
    next.k[move[1]] ^= 1;
    events.push({ type: 'spin', disc: move[1] });
  } else if (move[0] === 'shunt') {
    const r = move[1], i = routeStop(r, next, cfg), [c, n] = next.rivers[r].shift();
    next.stops[i].plat[c] += n;
    events.push({ type: 'shunt', river: r, stop: i, c, n });
  } else {
    const bus = next.lanes[move[1]].shift();
    next.stops[move[2]].bus = { ...bus, fill: 0 };
    events.push({ type: 'call', lane: move[1], stop: move[2], bus });
  }
  next.moves++;
  settle(next, cfg, events);
  return { state: next, events };
}

const isWon = (s) => s.rivers.every((r) => !r.length) && s.lanes.every((l) => !l.length) && s.stops.every((st) => !st.bus && !platUsed(st));

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

const FLOW_CFG = { bridge: true, bay: false, caps: [0, 0, 0, 0], unchain: false };

function flowStop(s, bus) {
  const free = [STOP_N, STOP_E, STOP_W].filter((i) => !s.stops[i].bus);
  const inRiver = (r) => s.rivers[r].reduce((n, [c, k]) => (c === bus.c ? n + k : n), 0);
  // The south river cannot reach the north stop.
  const allowed = free.filter((i) => i !== STOP_N || inRiver(RIVER_E) + inRiver(RIVER_W) >= bus.n);
  for (const i of allowed) for (let r = 0; r < 3; r++) if (s.rivers[r][0] && s.rivers[r][0][0] === bus.c && routeStop(r, s, FLOW_CFG) === i) return i;
  return allowed.length ? allowed[0] : null;
}

function flowMoves(s) {
  const out = [['spin', 0], ['spin', 1]];
  s.lanes.forEach((lane, l) => {
    if (!lane[0]) return;
    const i = flowStop(s, lane[0]);
    if (i !== null) out.push(['call', l, i]);
  });
  return out;
}

if (typeof module !== 'undefined') module.exports = { RIVER_E, RIVER_W, RIVER_S, STOP_N, STOP_E, STOP_W, STOP_BAY, routeStop, newState, clone, platUsed, settle, canCall, legalMoves, apply, isWon, isJammed, FLOW_CFG, flowStop, flowMoves };
