// VOIZEX site server: static page, waitlist, investor deck requests, Telegram bot with Approve/Decline.
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BREVO_API_KEY, MAIL_FROM, SECRET, PUBLIC_URL (optional)
// Nothing is stored on disk: every investor request lives inside a signed token carried by its Telegram card,
// so Approve works after a restart of the free instance.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const PUB = path.join(__dirname, 'public'), DECK = process.env.DECK_PATH || (fs.existsSync('/etc/secrets') ? '/etc/secrets/deck.pdf' : path.join(__dirname, 'private', 'deck.pdf'));
// Render Secret Files hold text, so the deck may be stored there as base64; it is decoded once at start.
// The deck ships encrypted in site/deck.enc; the key is derived from the bot token, so it opens only where the token lives.
// A new bot token means re-encrypting the deck.
const deckEnc = () => { const f = path.join(__dirname, 'deck.enc'), t = process.env.TELEGRAM_BOT_TOKEN; if (!t || !fs.existsSync(f)) return Buffer.alloc(0);
  const b = fs.readFileSync(f), key = crypto.createHmac('sha256', t).update('voizex-deck').digest(), d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };
const deckFile = () => { if (fs.existsSync(DECK) && fs.statSync(DECK).size) return fs.readFileSync(DECK);
  if (!fs.existsSync(path.dirname(DECK))) return deckEnc();
  const dir = path.dirname(DECK), parts = fs.readdirSync(dir).filter(f => f.startsWith('deck.part.')).sort();
  return parts.length ? Buffer.concat(parts.map(f => fs.readFileSync(path.join(dir, f)))) : deckEnc(); };
const deckPdf = () => { const b = deckFile(); return b.subarray(0, 4).toString() === '%PDF' ? b : Buffer.from(b.toString().replace(/\s+/g, ''), 'base64'); };
let DECK_BUF = null; const deck = () => { if (!DECK_BUF || !DECK_BUF.length) DECK_BUF = deckPdf(); return DECK_BUF; };
const FREE = new Set('gmail.com googlemail.com yahoo.com yahoo.co.uk ymail.com outlook.com hotmail.com live.com msn.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.de gmx.net mail.com yandex.ru yandex.com ya.ru mail.ru inbox.ru list.ru bk.ru rambler.ru zoho.com tutanota.com tuta.io hey.com qq.com 163.com 126.com web.de t-online.de libero.it orange.fr free.fr laposte.net seznam.cz wp.pl o2.pl rediffmail.com fastmail.com hushmail.com duck.com mailinator.com guerrillamail.com 10minutemail.com tempmail.com temp-mail.org yopmail.com'.split(' '));
const WEEK = 7 * 24 * 3600e3;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function tgApi(method, body) {
  const t = process.env.TELEGRAM_BOT_TOKEN; if (!t) { console.log('[telegram off]', method, body.text || ''); return null; }
  try { const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); if (!j.ok) console.error('tg', method, j.description); return j; }
  catch (e) { console.error('tg', method, e.message); return null; }
}
const tg = (html, kb) => tgApi('sendMessage', { chat_id: process.env.TELEGRAM_CHAT_ID, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });

async function mail(to, name, subject, text, attach) {
  const k = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (process.env.DEV_MAIL) { console.log('DEV MAIL', to, subject, attach ? attach.name : ''); return; }
  if (!k || !from) throw new Error('mail not configured');
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': k, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'Ann Fedotova', email: from }, replyTo: { email: from, name: 'Ann Fedotova' }, to: [{ email: to, name }], subject, textContent: text, ...(attach ? { attachment: [attach] } : {}) }) });
  if (!r.ok) throw new Error('mail ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// signed tokens: base64url(json) + '.' + hmac(kind|payload)
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = s => { try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return null; } };
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const seal = (kind, o) => { const p = b64(o); return p + '.' + sign(kind + '|' + p); };
const open = (kind, tok) => { const [p, s] = String(tok || '').split('.'); if (!p || !s || !safeEq(sign(kind + '|' + p), s)) return null; return unb64(p); };
const deckToken = r => seal('deck', { e: r.e, n: r.n, f: r.f, iat: Date.now(), exp: Date.now() + WEEK });

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < windowMs); a.push(now); hits.set(key, a); return a.length > max;
}
const HOOK = sign('hook').slice(0, 24);
const BASE = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

const host = u => { try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const base = h => h.split('.').slice(-2).join('.');

async function body(req, max = 20000) {
  return new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { rej(new Error('too big')); req.destroy(); } }); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } }); });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// Telegram button presses. The card carries the sealed request in a hidden link on the fund name.
async function onCallback(q) {
  const me = String(process.env.TELEGRAM_CHAT_ID), m = q.message;
  if (!m || String(m.chat.id) !== me || String(q.from && q.from.id) !== me) return tgApi('answerCallbackQuery', { callback_query_id: q.id });
  const answer = text => tgApi('answerCallbackQuery', { callback_query_id: q.id, text });
  const [act, mark] = String(q.data || '').split(':');
  const link = (m.entities || []).map(e => e.url || '').find(u => u.includes('#vz='));
  const r = link && open('req', decodeURIComponent(link.split('#vz=')[1]));
  if (!r || !mark || !link.includes(mark)) return answer('Request not found');
  await tgApi('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
  if (act === 'no') { answer('Declined'); return tgApi('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: `Declined: ${r.n}, ${r.f}` }); }
  if (act !== 'ok') return answer('');
  answer('Sending…');
  try {
    const pdf = deck().toString('base64');
    await mail(r.e, r.n, 'VOIZEX pitch deck', `Good afternoon, ${r.n}. This is Ann Fedotova, founder of VOIZEX. The pitch deck for you is attached.`, { name: 'VOIZEX-pitch-deck.pdf', content: pdf });
  } catch (e) {
    console.error(e.message);
    await tgApi('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'ok:' + mark }, { text: 'Decline', callback_data: 'no:' + mark }]] } });
    return tgApi('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: `Not sent to ${r.e}: ${e.message}` });
  }
  const url = `${BASE()}/api/deck?t=${deckToken(r)}`;
  return tgApi('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: `Sent: ${r.n}, ${r.e}`,
    reply_markup: r.wa ? { inline_keyboard: [[{ text: 'Send the deck link on WhatsApp', url: 'https://wa.me/' + r.wa + '?text=' + encodeURIComponent(`Good afternoon, ${r.n}. This is Ann Fedotova, founder of VOIZEX. The pitch deck for you: ${url}`) }]] } : undefined });
}

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
  if (req.method === 'POST' && u.pathname === '/api/investor/request') {
    if (limited('r' + ip, 5, 3600e3)) return json(res, 429, { error: 'Too many requests. Try again in an hour.' });
    const b = await body(req);
    const name = String(b.name || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase().slice(0, 200), fund = String(b.fund || '').trim().slice(0, 200), role = String(b.role || '').trim().slice(0, 120);
    const wa = String(b.whatsapp || '').replace(/\D/g, '').slice(0, 15);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(res, 400, { error: 'Check your name and email.' });
    if (wa.length < 8) return json(res, 400, { error: 'Check the WhatsApp number, with the country code.' });
    const ed = email.split('@')[1], fh = host(fund);
    if (!fh) return json(res, 400, { error: 'Add the fund website.' });
    const r = { e: email, n: name, f: fh, r: role, wa, at: Date.now() };
    const sealed = seal('req', r), mark = sealed.slice(-16);
    await tg(`<b>Investor opened the deck</b>\n${esc(name)}${role ? ', ' + esc(role) : ''}\nFund: <a href="https://${esc(fh)}/#vz=${sealed}">${esc(fh)}</a>\nEmail: ${esc(email)}\nWhatsApp: +${esc(wa)}`,
      [[{ text: 'Approve', callback_data: 'ok:' + mark }, { text: 'Decline', callback_data: 'no:' + mark }]]);
    return json(res, 200, { token: deckToken(r) });
  }
  if (req.method === 'POST' && u.pathname === '/api/tg/' + HOOK) {
    const b = await body(req, 100000); res.writeHead(200); res.end('ok');
    if (b.callback_query) await onCallback(b.callback_query);
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/deck') {
    const t = open('deck', u.searchParams.get('t'));
    if (!t || Date.now() > t.exp) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('This link has expired. Request the deck again on the VOIZEX site.'); }
    if (Date.now() - t.iat > 120e3 && !limited('d' + t.e + t.iat, 1, 30 * 60e3)) await tg(`<b>Deck opened again</b>\n${esc(t.n)}, ${esc(t.f)}`);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="VOIZEX-deck.pdf"', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
    return res.end(deck());
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
http.createServer((req, res) => route(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Try again.' }); })).listen(PORT, async () => {
  console.log('VOIZEX on', PORT);
  try { const raw = deckFile(), pdf = deck(); console.log('deck', DECK, 'raw', raw.length, 'starts', JSON.stringify(raw.subarray(0, 8).toString('latin1')), 'pdf', pdf.length); } catch (e) { console.log('deck missing', e.message); }
  if (process.env.TELEGRAM_BOT_TOKEN && BASE()) {
    const j = await tgApi('setWebhook', { url: `${BASE()}/api/tg/${HOOK}`, allowed_updates: ['callback_query'], drop_pending_updates: false });
    console.log('telegram webhook', j && j.ok ? 'set' : 'FAILED');
  }
});
