/**
 * TUG OF WAR — Servidor Multijugador
 * WebSockets en tiempo real
 * Puerto: 3000
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;

/* ══════════════════════════════════════
   ESTADO DEL JUEGO (centralizado)
══════════════════════════════════════ */
function freshState() {
  const q = genQ();
  return {
    ans:   q.answer,
    qtext: q.text,
    pos:   0,          // -50..+50  (neg=azul gana, pos=rojo gana)
    rnd:   1,
    sb:    0,  sr:  0, // puntos totales
    cb:    0,  cr:  0, // correctas por equipo
    over:  false,
    timer: 28,
    ib:    '',  ir: '' // buffers de input
  };
}

let G = freshState();
let timerInterval = null;

/* ══════════════════════════════════════
   CLIENTES CONECTADOS
   tipo: 'screen' | 'blue' | 'red'
══════════════════════════════════════ */
const clients = new Map(); // ws -> { type }

/* ══════════════════════════════════════
   GENERADOR DE PREGUNTAS
══════════════════════════════════════ */
function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function genQ() {
  var op, a, b, ans;
  if (Math.random() < 0.5) {
    /* Sumas: números pequeños, resultado máximo 18 */
    op = '+'; a = rnd(1, 9); b = rnd(1, 9); ans = a + b;
  } else {
    /* Restas: resultado siempre positivo, nunca negativo */
    op = '-'; b = rnd(1, 9); a = rnd(b, b + 9); ans = a - b;
  }
  return { text: a + ' ' + op + ' ' + b + ' = ?', answer: ans };
}

/* ══════════════════════════════════════
   BROADCAST
══════════════════════════════════════ */
function broadcast(msg, exclude) {
  const raw = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== exclude && ws.readyState === 1) ws.send(raw);
  }
}
function broadcastAll(msg) { broadcast(msg, null); }
function sendTo(ws, msg)   { if (ws.readyState===1) ws.send(JSON.stringify(msg)); }

function sendState(ws) {
  sendTo(ws, {
    type:  'state',
    qtext: G.qtext,
    pos:   G.pos,
    rnd:   G.rnd,
    sb:    G.sb,
    sr:    G.sr,
    over:  G.over,
    timer: G.timer,
    ib:    G.ib,
    ir:    G.ir
  });
}

function broadcastState() {
  const msg = {
    type:  'state',
    qtext: G.qtext,
    pos:   G.pos,
    rnd:   G.rnd,
    sb:    G.sb,
    sr:    G.sr,
    over:  G.over,
    timer: G.timer,
    ib:    G.ib,
    ir:    G.ir
  };
  broadcastAll(msg);
}

/* ══════════════════════════════════════
   TIMER
══════════════════════════════════════ */
const TS = 50;
function startTimer() {
  clearInterval(timerInterval);
  G.timer = TS;
  timerInterval = setInterval(() => {
    G.timer--;
    broadcastAll({ type: 'timer', value: G.timer });
    if (G.timer <= 0) {
      clearInterval(timerInterval);
      broadcastAll({ type: 'timeout' });
      setTimeout(() => nextQ(), 1000);
    }
  }, 1000);
}

function nextQ() {
  if (G.over) return;
  const q  = genQ();
  G.ans    = q.answer;
  G.qtext  = q.text;
  G.rnd   += 1;
  G.ib     = '';
  G.ir     = '';
  broadcastAll({ type: 'nextQ', qtext: G.qtext, rnd: G.rnd });
  startTimer();
}

/* ══════════════════════════════════════
   LÓGICA DE RESPUESTA
══════════════════════════════════════ */
const MA = 5, WT = 50;

function handleSubmit(team) {
  if (G.over) return;
  const buf = team === 'b' ? G.ib : G.ir;
  if (!buf) return;
  const val = parseInt(buf, 10);

  // limpiar buffer
  if (team === 'b') G.ib = ''; else G.ir = '';
  broadcastAll({ type: 'clearInput', team });

  if (val === G.ans) {
    clearInterval(timerInterval);
    if (team === 'b') { G.sb++; G.cb++; G.pos -= MA; }
    else              { G.sr++; G.cr++; G.pos += MA; }

    broadcastAll({ type: 'correct', team, sb: G.sb, sr: G.sr, pos: G.pos });

    if (Math.abs(G.pos) >= WT) {
      G.over = true;
      broadcastAll({ type: 'win', team, rnd: G.rnd, cb: G.cb, cr: G.cr });
    } else {
      setTimeout(() => nextQ(), 900);
    }
  } else {
    broadcastAll({ type: 'wrong', team });
  }
}

function handleInput(team, digit) {
  if (G.over) return;
  const k = team === 'b' ? 'ib' : 'ir';
  if (G[k].length >= 4) return;
  G[k] += digit;
  broadcastAll({ type: 'input', team, value: G[k] });
}

function handleDelete(team) {
  const k = team === 'b' ? 'ib' : 'ir';
  G[k] = G[k].slice(0, -1);
  broadcastAll({ type: 'input', team, value: G[k] });
}

/* ══════════════════════════════════════
   HTTP SERVER — sirve archivos estáticos
══════════════════════════════════════ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else if (req.url === '/blue') {
    filePath = path.join(__dirname, 'blue.html');
  } else if (req.url === '/red') {
    filePath = path.join(__dirname, 'red.html');
  } else {
    filePath = path.join(__dirname, req.url.replace(/^\//, ''));
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

/* ══════════════════════════════════════
   WEBSOCKET SERVER
══════════════════════════════════════ */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  clients.set(ws, { type: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'register':
        clients.set(ws, { type: msg.role });
        sendState(ws);
        console.log(`[+] Conectado: ${msg.role}`);
        // Notificar a pantalla que alguien se unió
        broadcastAll({ type: 'playerJoined', role: msg.role });
        break;

      case 'input':
        handleInput(msg.team, msg.digit);
        break;

      case 'delete':
        handleDelete(msg.team);
        break;

      case 'submit':
        handleSubmit(msg.team);
        break;

      case 'restart':
        clearInterval(timerInterval);
        G = freshState();
        broadcastAll({ type: 'restart', qtext: G.qtext });
        startTimer();
        break;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      console.log(`[-] Desconectado: ${info.type}`);
      broadcastAll({ type: 'playerLeft', role: info.type });
    }
    clients.delete(ws);
  });
});

/* ── Arrancar ── */
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   TUG OF WAR — Servidor Online       ║');
  console.log('╠══════════════════════════════════════╣');

  // Mostrar IPs disponibles
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`║  📺 Pantalla : http://${net.address}:${PORT}         `);
        console.log(`║  📱 Equipo 1 : http://${net.address}:${PORT}/blue    `);
        console.log(`║  📱 Equipo 2 : http://${net.address}:${PORT}/red     `);
        console.log('╚══════════════════════════════════════╝');
      }
    }
  }
  console.log('');
});

// Iniciar primer timer
startTimer();
