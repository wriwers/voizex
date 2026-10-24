// VOIZEX site server: static page, waitlist and investor verification, Telegram notifications.
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BREVO_API_KEY, MAIL_FROM, SECRET
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), dns = require('dns').promises;
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const PUB = path.join(__dirname, 'public'), DECK = process.env.DECK_PATH || (fs.existsSync('/etc/secrets/deck.pdf') ? '/etc/secrets/deck.pdf' : path.join(__dirname, 'private', 'deck.pdf'));
const FREE = new Set('gmail.com googlemail.com yahoo.com yahoo.co.uk ymail.com outlook.com hotmail.com live.com msn.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.de gmx.net mail.com yandex.ru yandex.com ya.ru mail.ru inbox.ru list.ru bk.ru rambler.ru zoho.com tutanota.com tuta.io hey.com qq.com 163.com 126.com web.de t-online.de libero.it orange.fr free.fr laposte.net seznam.cz wp.pl o2.pl rediffmail.com fastmail.com hushmail.com duck.com mailinator.com guerrillamail.com 10minutemail.com tempmail.com temp-mail.org yopmail.com'.split(' '));

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function tg(html) {
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) { console.log('[telegram off]', html); return; }
  try { await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) }); }
  catch (e) { console.error('telegram', e.message); }
}
async function mail(to, subject, text) {
  const k = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (process.env.DEV_MAIL) { console.log('DEV CODE MAIL', to, subject); return; }
  if (!k || !from) throw new Error('mail not configured');
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': k, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'VOIZEX', email: from }, to: [{ email: to }], subject, textContent: text }) });
  if (!r.ok) throw new Error('mail ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = s => { try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return null; } };
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// simple rate limits
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < windowMs); a.push(now); hits.set(key, a); return a.length > max;
}
const fails = new Map();

const host = u => { try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const base = h => h.split('.').slice(-2).join('.');

async function body(req, max = 20000) {
  return new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { rej(new Error('too big')); req.destroy(); } }); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } }); });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

async function route(req, res) {
  const u = new URL(req.url, 'http://x'), ip = ipOf(req);
  if (req.method === 'POST' && u.pathname === '/api/waitlist') {
    if (limited('w' + ip, 10, 3600e3)) return json(res, 429, { error: 'Too many requests. Try later.' });
    const b = await body(req); const email = String(b.email || '').trim().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(res, 400, { error: 'Check the email address.' });
    const q = b.quiz || {};
    await tg(`<b>New guest</b>\n${esc(email)}\nRoom: ${esc(b.room)}\nThoughts come: ${esc(q.when)}\nWhat happens to them: ${esc(q.fate)}\nWants: ${esc(q.want)}\nHow: ${esc(q.how)}${b.dream ? '\nNote: ' + esc(String(b.dream).slice(0, 300)) : ''}`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && u.pathname === '/api/investor/start') {
    if (limited('s' + ip, 5, 3600e3)) return json(res, 429, { error: 'Too many requests. Try again in an hour.' });
    const b = await body(req);
    const name = String(b.name || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase().slice(0, 200), fund = String(b.fund || '').trim().slice(0, 200), role = String(b.role || '').trim().slice(0, 120);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(res, 400, { error: 'Check your name and email.' });
    const ed = email.split('@')[1], fh = host(fund);
    if (FREE.has(ed)) return json(res, 400, { error: 'Use your work email at the fund, not a personal one.' });
    if (!fh || base(ed) !== base(fh)) return json(res, 400, { error: `Your email domain (${ed}) has to match the fund website.` });
    if (!process.env.DEV_MAIL) try { await dns.resolveMx(ed); } catch { return json(res, 400, { error: `We could not find a mail server for ${ed}.` }); }
    if (!process.env.DEV_MAIL) try { await dns.lookup(fh); } catch { return json(res, 400, { error: `We could not reach ${fh}.` }); }
    if (limited('e' + email, 3, 3600e3)) return json(res, 429, { error: 'Too many codes for this email. Try again in an hour.' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), exp = Date.now() + 10 * 60e3;
    const p = { e: email, n: name, f: fh, r: role, exp };
    const challenge = b64(p) + '.' + sign(b64(p) + '|' + code);
    try { await mail(email, `${code} is your VOIZEX code`, `Hello ${name},\n\nYour code to open the VOIZEX deck: ${code}\nIt works for 10 minutes.\n\nIf you did not ask for it, ignore this email.\n\nVOIZEX`); }
    catch (e) { console.error(e.message); await tg(`<b>Mail failed</b> for ${esc(email)}: ${esc(e.message)}`); return json(res, 502, { error: 'We could not send the code right now. Write to wriwers@outlook.com.' }); }
    await tg(`<b>Investor request</b>\n${esc(name)}${role ? ', ' + esc(role) : ''}\n${esc(email)}\nFund: ${esc(fh)}\nCode sent, waiting for confirmation.`);
    return json(res, 200, { challenge });
  }
  if (req.method === 'POST' && u.pathname === '/api/investor/verify') {
    const b = await body(req); const email = String(b.email || '').trim().toLowerCase(), code = String(b.code || '').replace(/\D/g, ''), [pp, sig] = String(b.challenge || '').split('.');
    const p = unb64(pp || '');
    if (!p || p.e !== email || !sig) return json(res, 400, { error: 'Start again and request a new code.' });
    if (Date.now() > p.exp) return json(res, 400, { error: 'The code expired. Request a new one.' });
    const f = (fails.get(pp) || 0); if (f >= 5) return json(res, 429, { error: 'Too many attempts. Request a new code.' });
    if (!safeEq(sign(pp + '|' + code), sig)) { fails.set(pp, f + 1); return json(res, 400, { error: 'That code is not right.' }); }
    const t = { e: p.e, n: p.n, f: p.f, exp: Date.now() + 48 * 3600e3 };
    const token = b64(t) + '.' + sign('deck|' + b64(t));
    await tg(`<b>Investor verified</b> ✓\n${esc(p.n)}\n${esc(p.e)}\nFund: ${esc(p.f)}`);
    const link = `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/deck?t=${token}`;
    mail(p.e, 'Your VOIZEX deck', `Hello ${p.n},\n\nHere is the VOIZEX deck. The link works for 48 hours:\n${link}\n\nAnn Fedotova\nFounder, VOIZEX\nTelegram: t.me/wriwers`).catch(e => console.error('deck mail', e.message));
    return json(res, 200, { token });
  }
  if (req.method === 'GET' && u.pathname === '/api/deck') {
    const [tp, sig] = String(u.searchParams.get('t') || '').split('.'); const t = unb64(tp || '');
    if (!t || !sig || !safeEq(sign('deck|' + tp), sig) || Date.now() > t.exp) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('This link has expired. Verify again on the VOIZEX site.'); }
    if (!limited('d' + tp, 1, 30 * 60e3)) await tg(`<b>Deck opened</b>\n${esc(t.n)}, ${esc(t.f)}`);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="VOIZEX-deck.pdf"', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
    return fs.createReadStream(DECK).pipe(res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    let f = path.normalize(path.join(PUB, decodeURIComponent(u.pathname)));
    if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    if (u.pathname === '/' || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(f).pipe(res);
  }
  res.writeHead(405); res.end();
}
http.createServer((req, res) => route(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Try again.' }); })).listen(PORT, () => console.log('VOIZEX on', PORT));
