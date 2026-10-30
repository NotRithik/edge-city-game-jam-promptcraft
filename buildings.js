// Public buildings drawn by code, so public works never wait on an AI. A design is a list of [x, y, z, block] relative
// to the centre of its plot: y 0 is the ground (floors replace the grass), the entrance faces +z, and everything stays
// within x and z -10..10. nation.js turns each design to face its street and hands the blocks to the citizen builders.
export const KINDS = {
  house: 'a few family houses with gardens', market: 'an open market hall with stalls', clinic: 'a clinic with a red cross',
  school: 'a two-storey school with a yard', library: 'a stone library with tall windows', workshop: 'a workshop with a wide door',
  kitchen: 'a community kitchen with a chimney and tables outside', park: 'a park with trees, paths, benches and a fountain',
  plaza: 'a paved square with a fountain and a statue', dock: 'a timber dock with a shed and crates', warehouse: 'a big brick warehouse',
};
const WORDS = [['park', /park|garden|green|playground|botanic/], ['plaza', /plaza|square|promenade|fountain/], ['dock', /dock|harbou?r|pier|jetty|wharf|port\b|boat|lighthouse/],
  ['market', /market|bazaar|shop|stall|trade|food hall/], ['clinic', /clinic|hospital|health|doctor|medical/], ['school', /school|college|academy|kindergarten/],
  ['library', /library|archive|museum|reading/], ['kitchen', /kitchen|canteen|restaurant|caf[eé]|bakery|food bank|soup/], ['warehouse', /warehouse|depot|storage|granary|silo/],
  ['workshop', /workshop|forge|mill|factory|timber|yard|studio|maker/], ['house', /house|home|housing|apartment|flat|cottage|villa|dorm|hostel/]];
export const kindOf = (text, zone) => WORDS.find(([, re]) => re.test(String(text || '').toLowerCase()))?.[0] || { homes: 'house', park: 'park', market: 'market', works: 'workshop' }[zone] || null;
export const zoneOf = (kind) => ({ house: 'homes', market: 'market', kitchen: 'market', park: 'park', plaza: 'park', dock: 'works', warehouse: 'works', workshop: 'works' })[kind] || 'civic';

const PALETTE = { base: 'stone_bricks', wall: 'white_wool', roof: 'red_wool', beam: 'log', trim: 'blue_wool', glass: 'glass', floor: 'planks', light: 'glowstone' };
function rng(seed) { let s = 0; for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function design(kind, { name = '', seed = name, palette = {} } = {}) {
  const P = { ...PALETTE, ...palette }, R = rng(seed + kind), out = new Map();
  const put = (x, y, z, k) => { if (Math.abs(x) <= 10 && Math.abs(z) <= 10 && y >= -4) out.set(`${x},${y},${z}`, [x, y, z, k]); };
  const box = (x0, y0, z0, x1, y1, z1, k) => { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, y, z, k); };
  const lamp = (x, z, y = 1) => { put(x, y, z, P.beam); put(x, y + 1, z, P.beam); put(x, y + 2, z, P.light); };
  const tree = (x, z) => { const h = 4 + Math.floor(R() * 2); for (let y = 1; y <= h; y++) put(x, y, z, 'log'); for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy) <= 3 && (dx || dz || dy > 0)) put(x + dx, h + dy + 1, z + dz, 'leaves'); };
  const bench = (x, z, alongX = true) => { for (let i = -1; i <= 1; i++) put(alongX ? x + i : x, 1, alongX ? z : z + i, 'planks'); };
  const fountain = (x, z) => { box(x - 2, 1, z - 2, x + 2, 1, z + 2, 'stone_bricks'); box(x - 1, 1, z - 1, x + 1, 1, z + 1, 'water'); put(x, 1, z, 'stone_bricks'); put(x, 2, z, 'stone_bricks'); put(x, 3, z, P.light); };

  // a house: walls with timber posts, windows, a door on +z, floors, a pitched roof (ridge along x) and lights inside
  function building(x0, z0, x1, z1, { floors = 1, storey = 4, wall = P.wall, roof = P.roof, door = 1, flat = false } = {}) {
    const H = floors * storey;
    box(x0, 0, z0, x1, 0, z1, P.floor);
    for (let y = 1; y <= H; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const edgeX = x === x0 || x === x1, edgeZ = z === z0 || z === z1; if (!edgeX && !edgeZ) continue;
      const post = (edgeX && edgeZ) || (edgeZ && (x - x0) % 4 === 0) || (edgeX && (z - z0) % 4 === 0), ly = (y - 1) % storey;
      const win = !post && (ly === 1 || ly === 2) && ((edgeZ ? x - x0 : z - z0) % 2 === 0);
      put(x, y, z, y === 1 && !post ? P.base : post ? P.beam : win ? P.glass : wall);
    }
    for (let f = 1; f < floors; f++) box(x0 + 1, f * storey, z0 + 1, x1 - 1, f * storey, z1 - 1, P.floor);
    const cx = Math.round((x0 + x1) / 2);
    for (let dx = -door + 1; dx <= door - 1 || dx === 0; dx++) { for (let y = 1; y <= 3; y++) put(cx + dx, y, z1, 'air'); if (dx >= door - 1) break; } // the doorway on the +z side
    put(cx - door, 4, z1, P.trim); put(cx + door, 4, z1, P.trim); put(cx, 4, z1 + 1 <= 10 ? z1 : z1, P.trim);
    for (let f = 0; f < floors; f++) put(cx, f * storey + storey - 1 + (f ? 0 : 0), Math.round((z0 + z1) / 2), P.light);
    if (flat) { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, H + 1, z, x === x0 || x === x1 || z === z0 || z === z1 ? P.base : P.floor); return H + 1; }
    const half = Math.ceil((z1 - z0 + 2) / 2);
    for (let i = 0; i < half; i++) for (let x = x0 - 1; x <= x1 + 1; x++) { put(x, H + 1 + i, z0 - 1 + i, roof); put(x, H + 1 + i, z1 + 1 - i, roof); }
    for (let i = 0; i < half - 1; i++) for (let z = z0 + i + 1; z <= z1 - i - 1; z++) { put(x0, H + 1 + i, z, wall); put(x1, H + 1 + i, z, wall); } // gable ends
    return H + half;
  }

  switch (kind) {
    case 'house': { // four family houses with gardens and a shared path
      const cols = ['white_wool', 'yellow_wool', 'pink_wool', 'white_wool'], roofs = ['red_wool', 'brick', 'red_wool', 'orange_wool'];
      box(-1, 0, -10, 1, 0, 10, 'gravel');
      [[-9, -9], [2, -9], [-9, 2], [2, 2]].forEach(([x, z], i) => { const w = 6 + Math.floor(R() * 2); building(x, z, x + w, z + 6, { floors: R() < 0.4 ? 2 : 1, wall: cols[(i + Math.floor(R() * 4)) % 4], roof: roofs[i] }); tree(x < 0 ? -10 : 10, z + 3); });
      lamp(0, 0); break;
    }
    case 'market': { // an open hall: columns, a broad roof, stalls with coloured awnings
      const x0 = -9, x1 = 9, z0 = -7, z1 = 7, H = 5;
      box(x0, 0, z0, x1, 0, z1, 'cobblestone');
      for (let x = x0; x <= x1; x += 3) for (const z of [z0, z1]) box(x, 1, z, x, H, z, P.beam);
      for (let z = z0; z <= z1; z += 3) for (const x of [x0, x1]) box(x, 1, z, x, H, z, P.beam);
      for (let i = 0; i <= 4; i++) box(x0 - 1 + i, H + 1 + i, z0 - 1 + i, x1 + 1 - i, H + 1 + i, z1 + 1 - i, i === 4 ? P.beam : P.roof);
      for (let i = 0; i <= 3; i++) box(x0 + i, H + 1 + i, z0 + i, x1 - i, H + 1 + i, z1 - i, 'air');
      const aw = ['orange_wool', 'yellow_wool', 'green_wool', 'red_wool', 'blue_wool'];
      for (let k = 0; k < 4; k++) { const x = -7 + k * 4; box(x, 1, -4, x + 2, 1, -4, 'planks'); box(x, 3, -5, x + 2, 3, -4, aw[k % 5]); box(x, 1, 3, x + 2, 1, 3, 'planks'); box(x, 3, 3, x + 2, 3, 4, aw[(k + 2) % 5]); }
      for (const [x, z] of [[-5, 0], [5, 0], [0, 0]]) put(x, H, z, P.light);
      lamp(-10, 9); lamp(10, 9); break;
    }
    case 'clinic': {
      building(-7, -6, 7, 5, { floors: 2, wall: 'white_wool', roof: 'brick', door: 2 });
      for (const [x, y] of [[0, 9], [-1, 9], [1, 9], [0, 10], [0, 8]]) put(x, y, 6, 'red_wool'); // the red cross over the door
      box(-3, 0, 6, 3, 0, 9, 'stone_bricks'); lamp(-4, 8); lamp(4, 8); tree(-9, 8); tree(9, 8); break;
    }
    case 'school': {
      building(-8, -8, 8, 2, { floors: 2, wall: 'white_wool', roof: 'red_wool', door: 2 });
      for (let x = -8; x <= 8; x++) put(x, 4, 2, 'yellow_wool');
      box(-8, 0, 3, 8, 0, 10, 'sand'); box(-6, 1, 9, -6, 3, 9, 'log'); box(6, 1, 9, 6, 3, 9, 'log'); box(-6, 4, 9, 6, 4, 9, 'yellow_wool'); // the yard with a gate bar
      tree(-10, 5); tree(10, 5); lamp(0, 10); break;
    }
    case 'library': {
      building(-8, -7, 8, 5, { floors: 2, storey: 5, wall: 'stone_bricks', roof: 'blue_wool', door: 2 });
      box(-4, 0, 6, 4, 0, 9, 'stone_bricks'); for (const x of [-3, 3]) box(x, 1, 6, x, 6, 6, 'stone_bricks'); box(-4, 7, 6, 4, 7, 7, 'stone_bricks'); // a portico
      lamp(-6, 9); lamp(6, 9); break;
    }
    case 'workshop': case 'warehouse': {
      const big = kind === 'warehouse';
      building(-9, -8, 9, big ? 6 : 3, { floors: 1, storey: big ? 7 : 5, wall: big ? 'brick' : 'planks', roof: big ? 'stone_bricks' : 'brick', door: 3 });
      box(-9, 0, big ? 7 : 4, 9, 0, 10, 'gravel');
      for (const [x, z] of [[-7, 8], [-5, 9], [7, 8]]) { put(x, 1, z, 'planks'); put(x, 2, z, R() < 0.5 ? 'log' : 'planks'); }
      lamp(-9, 10); lamp(9, 10); break;
    }
    case 'kitchen': {
      building(-6, -7, 6, 2, { floors: 1, storey: 5, wall: 'yellow_wool', roof: 'red_wool', door: 2 });
      box(4, 1, -5, 5, 11, -4, 'brick'); // the chimney
      for (const x of [-5, 0, 5]) { box(x - 1, 1, 6, x + 1, 1, 6, 'planks'); bench(x, 5); bench(x, 7); }
      box(-8, 0, 3, 8, 0, 9, 'cobblestone'); lamp(-8, 9); lamp(8, 9); break;
    }
    case 'park': {
      box(-10, 0, -1, 10, 0, 1, 'gravel'); box(-1, 0, -10, 1, 0, 10, 'gravel'); fountain(0, 0);
      for (const [x, z] of [[-6, -6], [6, -6], [-6, 6], [6, 6], [-9, -3], [9, 3], [3, -9], [-3, 9]]) tree(x, z);
      for (const [x, z, k] of [[-4, -4, 'pink_wool'], [4, -4, 'yellow_wool'], [-4, 4, 'red_wool'], [4, 4, 'purple_wool']]) box(x - 1, 0, z - 1, x + 1, 0, z + 1, k);
      bench(-5, 2); bench(5, -2); bench(2, 5, false); bench(-2, -5, false);
      lamp(-3, -3); lamp(3, 3); lamp(-3, 3); lamp(3, -3); break;
    }
    case 'plaza': {
      for (let z = -9; z <= 9; z++) for (let x = -9; x <= 9; x++) put(x, 0, z, (x + z) % 2 ? 'stone_bricks' : 'cobblestone');
      fountain(0, -3); box(-1, 1, 5, 1, 1, 7, 'stone_bricks'); box(0, 2, 6, 0, 4, 6, 'gold_block'); // a statue on a plinth
      for (const [x, z] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) { put(x, 1, z, 'grass'); tree(x, z); }
      bench(-5, 0, false); bench(5, 0, false); lamp(-6, -6); lamp(6, -6); lamp(-6, 6); lamp(6, 6); break;
    }
    case 'dock': {
      box(-8, 0, -2, 8, 0, 10, 'planks'); for (let x = -8; x <= 8; x += 4) for (const z of [-2, 4, 10]) box(x, -3, z, x, -1, z, 'log');
      building(-8, -9, 0, -3, { floors: 1, wall: 'planks', roof: 'brick' });
      for (const [x, z] of [[3, 0], [4, 0], [3, 1], [6, 6]]) { put(x, 1, z, 'planks'); if (R() < 0.5) put(x, 2, z, 'log'); }
      lamp(-8, 10); lamp(8, 10); lamp(8, -2); break;
    }
    default: building(-6, -6, 6, 4, { floors: 2 });
  }
  return [...out.values()].filter((b) => b[3] !== 'air'); // the plot is levelled first, so there is nothing to clear
}

// Small things citizens make for fun (a bench, a bonfire, a sandcastle...). [x, y, z, block] around the spot they pick:
// y 0 sits on the ground, everything within x and z -3..3.
export const PROPS = {
  bench: 'a wooden bench', flowers: 'a flower bed', lantern: 'a lantern post', fountain: 'a little fountain', swing: 'a swing',
  stall: 'a food stall with a striped awning', bonfire: 'a bonfire ring', sandcastle: 'a sandcastle', statue: 'a statue on a plinth',
  garden: 'a vegetable patch', picnic: 'a picnic table', mural: 'a painted mural wall', arch: 'a leafy arch',
};
const PROP_WORDS = [['bench', /bench|seat/], ['flowers', /flower|blossom|bloom|plant/], ['lantern', /lantern|lamp|light/], ['fountain', /fountain|pond|well/], ['swing', /swing|playground/],
  ['stall', /stall|stand|kiosk|cart|shop|chai|snack/], ['bonfire', /bonfire|camp ?fire|fire ?pit|barbecue|bbq/], ['sandcastle', /sand ?castle|castle/], ['statue', /statue|sculpture|monument|bust/],
  ['garden', /garden|veg|patch|herb|farm/], ['picnic', /picnic|table/], ['mural', /mural|paint|art|wall|graffiti/], ['arch', /arch|pergola|gate|bower/]];
export const propOf = (text) => PROP_WORDS.find(([, re]) => re.test(String(text || '').toLowerCase()))?.[0] || null;
const WOOLS = ['red_wool', 'orange_wool', 'yellow_wool', 'green_wool', 'blue_wool', 'purple_wool', 'pink_wool', 'white_wool'];
export function prop(kind, seed = '') {
  const R = rng(seed + kind), out = [], put = (x, y, z, k) => out.push([x, y, z, k]), pick = (l) => l[Math.floor(R() * l.length)];
  const box = (x0, y0, z0, x1, y1, z1, k) => { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, y, z, k); };
  switch (kind) {
    case 'bench': box(-1, 0, 0, 1, 0, 0, 'planks'); box(-1, 1, -1, 1, 1, -1, 'planks'); put(-2, 0, 0, 'log'); put(2, 0, 0, 'log'); break;
    case 'flowers': box(-2, 0, -1, 2, 0, 1, 'log'); box(-1, 0, 0, 1, 0, 0, 'dirt'); for (let x = -1; x <= 1; x++) put(x, 1, 0, pick(WOOLS.slice(0, 7))); break;
    case 'lantern': put(0, 0, 0, 'log'); put(0, 1, 0, 'log'); put(0, 2, 0, 'log'); put(0, 3, 0, 'glowstone'); break;
    case 'fountain': for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) if (Math.max(Math.abs(x), Math.abs(z)) === 2) put(x, 0, z, 'stone_bricks'); else put(x, 0, z, 'water'); box(0, 0, 0, 0, 1, 0, 'stone_bricks'); put(0, 2, 0, 'glowstone'); break;
    case 'swing': box(-2, 0, 0, -2, 2, 0, 'log'); box(2, 0, 0, 2, 2, 0, 'log'); box(-2, 3, 0, 2, 3, 0, 'planks'); put(0, 1, 0, 'planks'); break;
    case 'stall': { const a = pick(WOOLS.slice(0, 6)); box(-1, 0, 1, 1, 0, 1, 'planks'); for (const [x, z] of [[-2, -1], [2, -1], [-2, 1], [2, 1]]) box(x, 0, z, x, 2, z, 'log'); for (let x = -2; x <= 2; x++) box(x, 3, -1, x, 3, 1, x % 2 ? a : 'white_wool'); put(0, 1, 1, 'crafting_table'); break; }
    case 'bonfire': for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) put(x, 0, z, x || z ? 'cobblestone' : 'glowstone'); put(0, 1, 0, 'orange_wool'); put(-2, 0, 0, 'log'); put(2, 0, 0, 'log'); break;
    case 'sandcastle': box(-1, 0, -1, 1, 0, 1, 'sand'); for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) put(x, 1, z, 'sand'); box(0, 1, 0, 0, 2, 0, 'sand'); put(0, 3, 0, pick(['red_wool', 'yellow_wool', 'blue_wool'])); break;
    case 'statue': put(0, 0, 0, 'stone_bricks'); box(0, 1, 0, 0, 2, 0, 'stone'); put(0, 3, 0, pick(['gold_block', 'stone', 'diamond_block'])); put(-1, 2, 0, 'stone'); put(1, 2, 0, 'stone'); break;
    case 'garden': box(-2, 0, -1, 2, 0, 1, 'log'); box(-1, 0, -1, 1, 0, 1, 'dirt'); for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z += 2) put(x, 1, z, R() < 0.3 ? 'orange_wool' : 'green_wool'); break;
    case 'picnic': box(-1, 1, 0, 1, 1, 0, 'planks'); put(-1, 0, 0, 'log'); put(1, 0, 0, 'log'); box(-1, 0, -2, 1, 0, -2, 'planks'); box(-1, 0, 2, 1, 0, 2, 'planks'); break;
    case 'mural': for (let y = 0; y <= 2; y++) for (let x = -2; x <= 2; x++) put(x, y, 0, y === 0 ? 'stone_bricks' : pick(WOOLS)); break;
    case 'arch': box(-2, 0, 0, -2, 2, 0, 'log'); box(2, 0, 0, 2, 2, 0, 'log'); box(-2, 3, 0, 2, 3, 0, 'leaves'); put(-1, 3, -1, 'leaves'); put(1, 3, 1, 'leaves'); put(0, 4, 0, 'leaves'); break;
    default: return [];
  }
  return out;
}
