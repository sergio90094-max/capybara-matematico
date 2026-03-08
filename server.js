const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════
   ESTADO DEL JUEGO
══════════════════════════════════════ */
let gameDifficulty = 'easy';
let gameStarted    = false;
let gamePaused     = false;
let timerInterval  = null;

const MA = 5, WT = 50; // Mover 5 por respuesta, ganar en 50

function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function genQ() {
  const E = gameDifficulty === 'easy';
  const H = gameDifficulty === 'hard';
  const t = rnd(0, E ? 3 : H ? 7 : 5);
  let a, b, ans, text;

  if (t === 0) { // Suma directa
    a = rnd(1, E?5:H?20:10); b = rnd(1, E?5:H?20:10);
    ans = a+b; text = a+' + '+b+' = ?';
  } else if (t === 1) { // Resta directa
    a = rnd(2, E?10:H?20:15); b = rnd(1, a);
    ans = a-b; text = a+' - '+b+' = ?';
  } else if (t === 2) { // Suma con incógnita
    a = rnd(1, E?5:H?15:10); b = rnd(1, E?5:H?15:10);
    ans = b; text = a+' + ? = '+(a+b);
  } else if (t === 3) { // Contar — ¿cuántos hay?
    a = rnd(1, E?8:H?20:12);
    ans = a; text = '¿Cuánto es '+a+' + 0?';
  } else if (t === 4) { // Resta con incógnita
    a = rnd(3, E?10:H?20:15); b = rnd(1, a-1);
    ans = b; text = a+' - ? = '+(a-b);
  } else if (t === 5) { // Suma tres números
    a = rnd(1, E?4:H?10:6); b = rnd(1, E?4:H?10:6); const c=rnd(1,E?3:H?8:5);
    ans = a+b+c; text = a+' + '+b+' + '+c+' = ?';
  } else if (t === 6) { // Doble
    a = rnd(1, H?15:8);
    ans = a*2; text = 'Doble de '+a+' = ?';
  } else { // Completar
    a = rnd(1, H?15:10); b = rnd(a+1, a+H?15:8);
    ans = b-a; text = a+' + ? = '+b;
  }
  return { text, answer: ans };
}

function freshState() {
  const q = genQ();
  return {
    ans: q.answer, qtext: q.text,
    pos: 0, rnd: 1,
    sb: 0, sr: 0,
    cb: 0, cr: 0,
    over: false,
    timer: 30,
    ib: '', ir: ''
  };
}

let G = freshState();

/* ══════════════════════════════════════
   CLIENTES
══════════════════════════════════════ */
const clients = new Map(); // ws → { type }

function broadcastAll(msg) {
  const raw = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(raw);
  }
}
function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function sendState(ws) {
  sendTo(ws, { type:'state', ...G });
}

/* ══════════════════════════════════════
   TIMER
══════════════════════════════════════ */
function startTimer() {
  clearInterval(timerInterval);
  G.timer = 30;
  timerInterval = setInterval(() => {
    if (gamePaused) return;
    G.timer--;
    broadcastAll({ type:'timer', value: G.timer });
    if (G.timer <= 0) {
      clearInterval(timerInterval);
      broadcastAll({ type:'timeout' });
      setTimeout(nextQ, 1200);
    }
  }, 1000);
}

function nextQ() {
  if (G.over) return;
  const q = genQ();
  G.ans = q.answer; G.qtext = q.text;
  G.rnd++; G.ib = ''; G.ir = '';
  wrongThisQ.clear();
  broadcastAll({ type:'nextQ', qtext: q.text, rnd: G.rnd });
  startTimer();
}

let wrongThisQ = new Set();

function handleSubmit(team) {
  if (!gameStarted || gamePaused || G.over) return;
  const buf = team === 'b' ? G.ib : G.ir;
  const val = parseInt(buf);
  if (isNaN(val)) return;

  if (val === G.ans) {
    // Correcto
    wrongThisQ.clear();
    if (team === 'b') { G.sb += 10; G.cb++; G.pos -= MA; }
    else              { G.sr += 10; G.cr++; G.pos += MA; }
    broadcastAll({ type:'correct', team, pos: G.pos, sb: G.sb, sr: G.sr, cb: G.cb, cr: G.cr });
    if (Math.abs(G.pos) >= WT) {
      G.over = true;
      clearInterval(timerInterval);
      const winner = G.pos <= -WT ? 'b' : 'r';
      setTimeout(() => broadcastAll({ type:'win', team: winner, rnd: G.rnd, cb: G.cb, cr: G.cr }), 400);
    } else {
      setTimeout(nextQ, 800);
    }
  } else {
    // Incorrecto
    wrongThisQ.add(team);
    broadcastAll({ type:'wrong', team });
    if (wrongThisQ.size >= 2) {
      broadcastAll({ type:'bothWrong' });
      setTimeout(nextQ, 1200);
    }
  }
}

function handleInput(team, digit) {
  if (!gameStarted || G.over) return;
  const buf = (team === 'b' ? G.ib : G.ir) + digit;
  if (team === 'b') G.ib = buf; else G.ir = buf;
  broadcastAll({ type:'input', team, value: buf });
}
function handleDelete(team) {
  if (!gameStarted || G.over) return;
  const buf = team === 'b' ? G.ib : G.ir;
  const nb = buf.slice(0,-1);
  if (team === 'b') G.ib = nb; else G.ir = nb;
  broadcastAll({ type:'input', team, value: nb });
}

/* ══════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════ */
const httpServer = http.createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200); res.end('OK'); return; }
  let filePath;
  if (req.url === '/' || req.url === '/index.html') filePath = path.join(__dirname, 'index.html');
  else if (req.url === '/blue') filePath = path.join(__dirname, 'blue.html');
  else if (req.url === '/red')  filePath = path.join(__dirname, 'red.html');
  else filePath = path.join(__dirname, req.url.replace(/^\//, ''));

  const ext = path.extname(filePath);
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                 '.mp3':'audio/mpeg', '.png':'image/png', '.jpg':'image/jpeg' }[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  clients.set(ws, { type: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ping': return;

      case 'register':
        clients.set(ws, { type: msg.role });
        if (!gameStarted) sendTo(ws, { type:'waiting' });
        else { sendState(ws); if (gamePaused) sendTo(ws, { type:'pause', paused:true }); }
        if (msg.role === 'blue' || msg.role === 'red')
          broadcastAll({ type:'playerJoined', role: msg.role });
        break;

      case 'startGame':
        if (!gameStarted) {
          gameDifficulty = msg.difficulty || 'easy';
          gameStarted = true; gamePaused = false;
          G = freshState();
          // En modo solo, el servidor maneja ambos equipos desde la pantalla
          if (msg.solo) G.soloMode = true;
          broadcastAll({ type:'restart', qtext: G.qtext, solo: !!msg.solo });
          startTimer();
        }
        break;

      case 'input':  handleInput(msg.team, msg.digit); break;
      case 'delete': handleDelete(msg.team); break;
      case 'submit': handleSubmit(msg.team); break;

      case 'pause':
        gamePaused = !gamePaused;
        broadcastAll({ type:'pause', paused: gamePaused });
        break;

      case 'restart':
        clearInterval(timerInterval);
        gameStarted = false; gamePaused = false;
        G = freshState();
        broadcastAll({ type:'restart', qtext: G.qtext });
        break;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    clients.delete(ws);
    if (info && info.type === 'screen') {
      clearInterval(timerInterval);
      gameStarted = false; gamePaused = false;
      G = freshState();
      broadcastAll({ type:'hostLeft' });
    }
  });

  ws.on('error', () => ws.close());
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🐾 La Aventura Capybara — Puerto ${PORT}`);
  console.log(`   Pantalla : http://localhost:${PORT}`);
  console.log(`   Azul     : http://localhost:${PORT}/blue`);
  console.log(`   Rojo     : http://localhost:${PORT}/red`);
});

process.on('uncaughtException',  e => console.error('[error]', e.message));
process.on('unhandledRejection', e => console.error('[reject]', e));
