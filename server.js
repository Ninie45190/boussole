// Boussole — serveur de groupes (aucune dépendance)
// Les positions restent en mémoire uniquement : rien n'est écrit sur disque.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5500;
const PUBLIC = path.join(__dirname, 'docs');

const GROUP_TTL = 24 * 3600 * 1000;   // un groupe inactif disparaît après 24 h
const MEMBER_TTL = 12 * 3600 * 1000;  // un membre silencieux disparaît après 12 h
const MAX_MEMBERS = 60;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O (confusion avec 1 et 0)

/** code -> { touched, members: Map(id -> {name, lat, lon, acc, posAt, seenAt, seeking}) } */
const groups = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!groups.has(c)) return c;
  }
}

function cleanCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}
function cleanName(v) {
  return String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
}
function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, g] of groups) {
    for (const [id, m] of g.members) if (now - m.seenAt > MEMBER_TTL) g.members.delete(id);
    if (now - g.touched > GROUP_TTL) groups.delete(code);
  }
}, 60 * 1000).unref();

// Le site peut être servi depuis une autre adresse (GitHub Pages) : l'API accepte donc les appels croisés.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function api(req, res, route) {
  const b = await readBody(req);

  if (route === '/api/create') {
    const code = newCode();
    groups.set(code, { touched: Date.now(), members: new Map() });
    return send(res, 200, { code });
  }

  if (route === '/api/check') {
    const code = cleanCode(b.code);
    return send(res, groups.has(code) ? 200 : 404, { ok: groups.has(code), code });
  }

  // Appelé toutes les 2 s par chaque téléphone : envoie sa position, reçoit celles des autres.
  if (route === '/api/sync') {
    const code = cleanCode(b.code);
    const id = String(b.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    const name = cleanName(b.name);
    if (code.length !== 4 || id.length < 8 || !name) return send(res, 400, { error: 'invalide' });

    let g = groups.get(code);
    if (!g) { g = { touched: 0, members: new Map() }; groups.set(code, g); } // serveur redémarré
    const now = Date.now();
    g.touched = now;

    let m = g.members.get(id);
    if (!m) {
      if (g.members.size >= MAX_MEMBERS) return send(res, 403, { error: 'groupe complet' });
      m = { name, lat: null, lon: null, acc: null, posAt: 0, seenAt: now, seeking: null };
      g.members.set(id, m);
    }
    m.name = name;
    m.seenAt = now;
    m.seeking = b.seeking ? String(b.seeking).slice(0, 32) : null;
    const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180);
    if (lat !== null && lon !== null) {
      m.lat = lat; m.lon = lon; m.acc = num(b.acc, 0, 100000); m.posAt = now;
    }

    const members = [];
    for (const [mid, x] of g.members) {
      members.push({
        id: mid, name: x.name, lat: x.lat, lon: x.lon, acc: x.acc,
        posAge: x.posAt ? now - x.posAt : null, // âges plutôt que dates : pas de souci d'horloge
        seenAge: now - x.seenAt,
        seeking: now - x.seenAt < 15000 ? x.seeking : null,
      });
    }
    return send(res, 200, { members });
  }

  if (route === '/api/leave') {
    const g = groups.get(cleanCode(b.code));
    if (g) g.members.delete(String(b.id || ''));
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'inconnu' });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

http.createServer((req, res) => {
  const route = decodeURIComponent(req.url.split('?')[0]);
  if (route.startsWith('/api/')) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (route === '/api/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST attendu' });
    return api(req, res, route).catch(() => send(res, 500, { error: 'erreur' }));
  }
  const file = path.normalize(path.join(PUBLIC, route === '/' ? 'index.html' : route));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Boussole : http://localhost:${PORT}`));
