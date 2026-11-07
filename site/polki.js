// Полки — бот @ann_polki_bot, облачная часть. Живёт в этом же сервисе на Render, работает без мака.
// Данные — JSON-файл, закреплённый в чате бота с Анной: при старте читается оттуда, при правке подменяется на месте.
// Токен бота и ключ ElevenLabs лежат в polki.enc, шифр от TELEGRAM_BOT_TOKEN — как дека.
// Мак, когда открыт, присылает сюда ответы из почты и чатов (/polki/signal) и забирает полки для хранилища (/polki/state).
const fs = require('fs'), path = require('path'), crypto = require('crypto');

let CFG = null;
function cfg() {
  if (CFG) return CFG;
  const f = path.join(__dirname, 'polki.enc'), t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t || !fs.existsSync(f)) return null;
  const b = fs.readFileSync(f), key = crypto.createHmac('sha256', t).update('polki').digest(),
    d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  CFG = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  return CFG;
}
const hm = s => crypto.createHmac('sha256', cfg().token).update(s).digest('hex');
const HOOK = () => '/polki/hook/' + hm('hook').slice(0, 24);
const TZ = 4 * 3600e3;                       // Дубай
const DIGEST_HOUR = 10, STALE_WORK = 7, STALE_WAIT = 5, FOCUS_MIN = 10;
const STATUSES = ['в работе', 'ждём', 'пауза', 'заброшено'];
const MARK = { 'в работе': '▶', 'ждём': '⏳', 'пауза': '⏸', 'заброшено': '·' };

let DATA = null, PIN = null, saveTimer = null, ready = null;

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const local = () => new Date(Date.now() + TZ);
const today = () => local().toISOString().slice(0, 10);
const hhmm = () => local().toISOString().slice(11, 16);
const daysSince = d => { const t = Date.parse(d); return isNaN(t) ? 0 : Math.floor((Date.parse(today()) - t) / 864e5); };

async function api(method, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg().token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!j.ok && !/not modified/.test(j.description || '')) console.error('polki tg', method, j.description); return j;
    } catch (e) { console.error('polki tg', method, e.message); await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  return null;
}
const chat = () => DATA && DATA.chat_id;
const send = (text, kb) => api('sendMessage', { chat_id: chat(), text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
const edit = async (mid, text, kb) => {
  const j = await api('editMessageText', { chat_id: chat(), message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
  if (!j || (!j.ok && !/not modified/.test(j.description || ''))) return send(text, kb);
};

// ---------- данные: закреплённый файл в чате ----------
async function load() {
  const c = await api('getChat', { chat_id: cfg().chat_id });
  const pm = c && c.ok && c.result.pinned_message;
  if (!pm || !pm.document) throw new Error('нет закреплённого файла с полками');
  const f = await api('getFile', { file_id: pm.document.file_id });
  const r = await fetch(`https://api.telegram.org/file/bot${cfg().token}/${f.result.file_path}`);
  DATA = JSON.parse(await r.text()); PIN = pm.message_id;
  DATA.chat_id = cfg().chat_id; DATA.state = DATA.state || {};
  console.log('polki: loaded', DATA.shelves.length, 'shelves, pin', PIN);
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1500); }
async function flush() {
  const fd = new FormData();
  fd.append('chat_id', String(chat())); fd.append('message_id', String(PIN));
  fd.append('media', JSON.stringify({ type: 'document', media: 'attach://f', caption: 'Полки — данные бота. Не удалять и не откреплять. ' + today() + ' ' + hhmm() }));
  fd.append('f', new Blob([JSON.stringify(DATA, null, 1)], { type: 'application/json' }), 'polki.json');
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg().token}/editMessageMedia`, { method: 'POST', body: fd });
    const j = await r.json(); if (!j.ok) { console.error('polki save', j.description); if (!/not modified/.test(j.description)) setTimeout(flush, 10000); }
  } catch (e) { console.error('polki save', e.message); setTimeout(flush, 10000); }
}

const shelf = n => DATA.shelves.find(s => s.n === Number(n));
function addLog(s, text, kind = 'заметка', energy = '') {
  (s.log = s.log || []).unshift({ date: today(), time: hhmm(), kind, text, energy });
  if (s.log.length > 200) s.log.length = 200;
  s.touched = today();
}

// ---------- экраны ----------
function fmtDay(iso) {
  const d = Date.parse(iso); if (isNaN(d)) return iso;
  const delta = Math.round((d - Date.parse(today())) / 864e5);
  const word = delta < 0 ? `просрочено ${-delta} дн.` : ({ 0: 'сегодня', 1: 'завтра' })[delta];
  return iso.slice(8, 10) + '.' + iso.slice(5, 7) + (word ? ` (${word})` : '');
}
const soonest = s => { const t = (s.tails || []).filter(x => x.due).sort((a, b) => a.due < b.due ? -1 : 1)[0]; return t ? fmtDay(t.due) : ''; };
function boardText() {
  const L = ['<b>Полки</b>'];
  for (const st of STATUSES) {
    const g = DATA.shelves.filter(s => s.status === st); if (!g.length) continue;
    L.push('', `<b>${st}</b>`);
    for (const s of g) {
      const d = daysSince(s.touched); let tail = '';
      if (st === 'в работе' && d >= STALE_WORK) tail = ` — не трогала ${d} дн.`;
      if (st === 'ждём' && d >= STALE_WAIT) tail = ` — ждём ${d} дн., пнуть?`;
      const due = soonest(s); if (due) tail += ` — ⚑ ${due}`;
      L.push(`${MARK[st]} ${s.n}. ${esc(s.name)}${esc(tail)}`);
    }
  }
  return L.join('\n');
}
const boardKb = () => { const b = DATA.shelves.map(s => ({ text: String(s.n), callback_data: 'open:' + s.n })); return [b.slice(0, 4), b.slice(4)]; };
function cardText(s) {
  const L = [`<b>${s.n}. ${esc(s.name)}</b>  ${MARK[s.status]} ${s.status}`];
  if (s.now) L.push('', esc(s.now));
  if (s.waiting) L.push('', 'ждём: ' + esc(s.waiting));
  if (s.next) L.push('дальше: ' + esc(s.next));
  if ((s.tails || []).length) { L.push(''); s.tails.forEach((t, i) => L.push(`${i + 1}) ${esc(t.text)}${t.due ? ' — ⚑ ' + esc(fmtDay(t.due)) : ''}`)); }
  const lg = (s.log || []).slice(0, 4);
  if (lg.length) { L.push(''); for (const e of lg) L.push(`<i>${e.date.slice(8, 10)}.${e.date.slice(5, 7)} ${esc(e.kind)}: ${esc(e.text.slice(0, 140))}</i>${{ '+': ' ✨', '-': ' 🪨' }[e.energy] || ''}`); }
  const plus = (s.log || []).filter(e => e.energy === '+').length, minus = (s.log || []).filter(e => e.energy === '-').length;
  if (plus || minus) L.push(`\nв кайф ${plus} · тяжело ${minus}`);
  return L.join('\n');
}
function cardKb(s) {
  const n = s.n, kb = [
    [{ text: '✓ сдвинулось', callback_data: `moved:${n}` }, { text: '⏳ ждём', callback_data: `st:${n}:ждём` }, { text: '⏸ пауза', callback_data: `st:${n}:пауза` }],
    [{ text: '✨ в кайф', callback_data: `en:${n}:+` }, { text: '🪨 тяжело', callback_data: `en:${n}:-` }, { text: '▶ в работу', callback_data: `st:${n}:в работе` }]];
  if ((s.tails || []).length) kb.push(s.tails.slice(0, 6).map((_, i) => ({ text: `✓${i + 1}`, callback_data: `done:${n}:${i + 1}` })));
  kb.push([{ text: '← все полки', callback_data: 'board' }]);
  return kb;
}
const pickKb = () => DATA.shelves.map(s => [{ text: `${s.n}. ${s.name.slice(0, 22)}`, callback_data: 'put:' + s.n }]);

// ---------- её реплики ----------
// голосом номер звучит словом: «семь, …», «полка пять …», «третья — …»
const NUMW = [[/^(одна|один|первая|первый|первую)(?![а-яё])/, 1], [/^(два|две|вторая|второй|вторую)(?![а-яё])/, 2], [/^(три|третья|третий|третью)(?![а-яё])/, 3],
  [/^(четыре|четвёртая|четвертая|четвёртый|четвертый|четвёртую|четвертую)(?![а-яё])/, 4], [/^(пять|пятая|пятый|пятую)(?![а-яё])/, 5],
  [/^(шесть|шестая|шестой|шестую)(?![а-яё])/, 6], [/^(семь|седьмая|седьмой|седьмую)(?![а-яё])/, 7]];
function spokenNumber(text) {
  let t = text.trim().replace(/^(полка|полку|на полку|в полку)\s+/i, '').toLowerCase();
  for (const [re, n] of NUMW) { const m = re.exec(t); if (m) return [n, t.slice(m[0].length).replace(/^[\s.,:;—\-]+/, '')]; }
  return null;
}
function route(text) {
  const sp = spokenNumber(text);
  if (sp && shelf(sp[0])) return [sp[0], text.trim().slice(text.trim().length - sp[1].length) || sp[1]];
  const m = /^\s*(?:полка\s+)?([1-9])[\s.:)\-]/i.exec(text + ' ');
  if (m && shelf(m[1])) return [Number(m[1]), text.slice(m[0].length).trim()];
  const low = text.toLowerCase(), hits = new Set();
  for (const s of DATA.shelves) if ((s.keys || []).some(k => low.includes(k))) hits.add(s.n);
  return hits.size === 1 ? [[...hits][0], text] : [0, text];
}
function take(n, text) {
  const s = shelf(n), low = text.toLowerCase().trim(); let due = '';
  const m = /(?:^|\s)до\s+(\d{1,2})[./](\d{1,2})(?!\d)/.exec(low);
  if (m) {
    let y = Number(today().slice(0, 4)); const iso = (yy) => `${yy}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (Date.parse(iso(y)) < Date.parse(today()) - 30 * 864e5) y++; if (!isNaN(Date.parse(iso(y)))) due = iso(y);
  }
  let what;
  if (/^(надо |нужно |\+)/.test(low)) { const t = text.replace(/^\+\s*/, '').trim(); (s.tails = s.tails || []).push({ text: t, due }); addLog(s, t, 'хвост'); what = 'хвост'; }
  else { addLog(s, text, 'заметка'); what = 'записала'; }
  save();
  return `→ ${s.n}. ${esc(s.name)} — ${what}`;
}
async function transcribe(fileId) {
  const f = await api('getFile', { file_id: fileId }); if (!f || !f.ok) return '';
  const audio = await (await fetch(`https://api.telegram.org/file/bot${cfg().token}/${f.result.file_path}`)).arrayBuffer();
  const fd = new FormData(); fd.append('model_id', 'scribe_v1'); fd.append('language_code', 'rus');
  fd.append('file', new Blob([audio]), path.basename(f.result.file_path));
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': cfg().eleven }, body: fd });
    const j = await r.json(); return (j.text || '').trim();
  } catch (e) { console.error('polki stt', e.message); return ''; }
}

async function onMessage(m) {
  if (m.chat.id !== chat()) return;
  const st = DATA.state; let text = (m.text || m.caption || '').trim();
  const voice = m.voice || m.audio || m.video_note;
  if (voice) {
    text = await transcribe(voice.file_id);
    if (!text) return send('не расслышала — расшифровка пустая. Скажи ещё раз или напиши.');
    await send('<i>' + esc(text.slice(0, 600)) + '</i>');
  }
  if (!text) return;
  const low = text.toLowerCase();
  if (['/start', '/board', 'полки', 'все', '/all', 'доска'].includes(low)) return send(boardText(), boardKb());
  if (['/digest', 'сводка', 'утро'].includes(low)) return digest(true);
  let [n, rest] = route(text);
  if (!n && st.focus && st.focus.n && Date.now() < st.focus.until) { n = st.focus.n; rest = text; }
  if (n) {
    st.last_note = { n, text: rest || text };
    return send(take(n, rest || text), [[{ text: 'не туда', callback_data: 'reroute' }, { text: 'открыть', callback_data: 'open:' + n }]]);
  }
  st.pending = text; save();
  return send('на какую полку?', pickKb());
}

async function onCallback(q) {
  api('answerCallbackQuery', { callback_query_id: q.id });   // сразу, чтобы кнопка не крутилась
  if (!q.message || q.message.chat.id !== chat()) return;
  const mid = q.message.message_id, d = q.data || '', st = DATA.state;
  if (d === 'board') return edit(mid, boardText(), boardKb());
  const [kind, a, b] = d.split(':');
  const s = shelf(a);
  if (kind === 'open' && s) return edit(mid, cardText(s), cardKb(s));
  if (kind === 'st' && s) { if (s.status !== b) { addLog(s, `${s.status} → ${b}`, 'статус'); s.status = b; save(); } return edit(mid, cardText(s), cardKb(s)); }
  if (kind === 'en' && s) { addLog(s, b === '+' ? 'в кайф' : 'тяжело', 'ощущение', b); save(); return edit(mid, cardText(s), cardKb(s)); }
  if (kind === 'moved' && s) {
    addLog(s, 'сдвинулось', 'движение'); st.focus = { n: s.n, until: Date.now() + FOCUS_MIN * 60e3 }; save();
    await edit(mid, cardText(s), cardKb(s));
    return send(`отметила. Хочешь — скажи голосом, что именно: в ближайшие ${FOCUS_MIN} минут ляжет сюда же. Не хочешь — уже записано.`);
  }
  if (kind === 'done' && s) { const i = Number(b) - 1; if (s.tails && s.tails[i]) { const t = s.tails.splice(i, 1)[0]; addLog(s, t.text, 'закрыт хвост'); save(); } return edit(mid, cardText(s), cardKb(s)); }
  if (kind === 'put' && s) { const t = st.pending; if (!t) return; st.pending = ''; st.last_note = { n: s.n, text: t }; return edit(mid, take(s.n, t)); }
  if (kind === 'reroute') {
    const ln = st.last_note || {}, x = shelf(ln.n);
    if (x && x.log && x.log.length) { const e = x.log.shift(); if (e.kind === 'хвост' && x.tails && x.tails.length && x.tails[x.tails.length - 1].text === e.text) x.tails.pop(); st.pending = ln.text || ''; save(); }
    return edit(mid, 'куда тогда?', pickKb());
  }
}

// ---------- сводка ----------
async function digest(force) {
  const st = DATA.state;
  if (!force && (st.digest_day === today() || local().getUTCHours() < DIGEST_HOUR)) return;
  const hot = [], fresh = [], wait = [], stale = [];
  for (const s of DATA.shelves) {
    for (const t of s.tails || []) if (t.due && (Date.parse(t.due) - Date.parse(today())) / 864e5 <= 2) hot.push(`⚑ ${s.n}. ${t.text} — ${fmtDay(t.due)}`);
    const d = daysSince(s.touched);
    if (s.status === 'ждём' && d >= STALE_WAIT) wait.push(`⏳ ${s.n}. ${s.name} — ${s.waiting || 'ответ'}, ${d} дн.`);
    if (s.status === 'в работе' && d >= STALE_WORK) stale.push(`▶ ${s.n}. ${s.name} — не трогала ${d} дн.`);
    for (const e of s.log || []) if (e.kind === 'входящее' && daysSince(e.date) <= 1) fresh.push(`✉ ${s.n}. ${e.text.slice(0, 90)}`);
  }
  const L = ['<b>Сводка</b>'];
  if (hot.length) L.push('', '<b>горит</b>', ...hot.map(esc));
  if (fresh.length) L.push('', '<b>ответили</b>', ...fresh.slice(0, 6).map(esc));
  if (wait.length) L.push('', '<b>пнуть</b>', ...wait.map(esc));
  if (stale.length) L.push('', '<b>застыло</b>', ...stale.map(esc));
  if (L.length === 1) L.push('ничего не горит. Можно просто делать своё.');
  const j = await send(L.join('\n'), boardKb());
  if (j && j.ok && !force) { st.digest_day = today(); save(); }
}

// ---------- сигналы с мака ----------
async function onSignal(items) {
  const out = [];
  for (const it of items || []) {
    const s = shelf(it.n); if (!s) continue;
    if (it.kind === 'автоответ') { addLog(s, `${it.who}: автоответ`, 'автоответ'); continue; }
    addLog(s, `${it.who}: ${it.gist}`, 'входящее');
    if (s.status === 'ждём' && it.wake) { addLog(s, 'ждём → в работе (пришёл ответ)', 'статус'); s.status = 'в работе'; }
    out.push(it);
  }
  if (items && items.length) save();
  for (const it of out) await send(`<b>${it.n}. ${esc(shelf(it.n).name)}</b> — ${esc(it.who)} (${esc(it.channel || '')})\n<i>${esc(it.gist)}</i>`, [[{ text: 'открыть полку', callback_data: 'open:' + it.n }]]);
  return out.length;
}

// ---------- вход в сервер ----------
async function init(base) {
  if (!cfg()) { console.log('polki: off (нет polki.enc или TELEGRAM_BOT_TOKEN)'); return; }
  ready = (async () => {
    await load();
    await api('setWebhook', { url: base + HOOK(), secret_token: hm('secret').slice(0, 32), allowed_updates: ['message', 'callback_query'] });
    await api('setMyCommands', { commands: [{ command: 'board', description: 'все полки' }, { command: 'digest', description: 'сводка сейчас' }] });
    setInterval(() => digest(false).catch(e => console.error('polki digest', e)), 60e3);
    console.log('polki: up, webhook set');
  })().catch(e => { console.error('polki init', e.message); ready = null; });
}

// true — запрос наш и обработан
async function handle(req, res, u, readBody) {
  if (!u.pathname.startsWith('/polki/') || !cfg()) return false;
  const j = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/polki/ping') { if (ready) await ready; if (DATA) digest(false).catch(() => {}); j(200, { ok: !!DATA, at: today() + ' ' + hhmm() }); return true; }
  if (req.method === 'POST' && u.pathname === HOOK()) {
    if (req.headers['x-telegram-bot-api-secret-token'] !== hm('secret').slice(0, 32)) { j(403, {}); return true; }
    const upd = await readBody(req, 200000); j(200, { ok: true });      // Telegram ждёт ответа быстро — отвечаем сразу
    if (ready) await ready; if (!DATA) return true;
    try { if (upd.message) await onMessage(upd.message); else if (upd.callback_query) await onCallback(upd.callback_query); }
    catch (e) { console.error('polki update', e); }
    return true;
  }
  const authed = req.headers['x-polki-key'] === hm('mac');
  if (u.pathname === '/polki/state' && authed) { if (ready) await ready; j(200, DATA || {}); return true; }
  if (req.method === 'POST' && u.pathname === '/polki/put' && authed) {
    // правка полок из сессии Claude на маке: присылается файл целиком
    if (ready) await ready; const b = await readBody(req, 2000000);
    if (!b.shelves) { j(400, { error: 'нет shelves' }); return true; }
    DATA = { ...b, chat_id: cfg().chat_id, state: b.state || DATA.state }; await flush(); j(200, { ok: true }); return true;
  }
  if (req.method === 'POST' && u.pathname === '/polki/signal' && authed) {
    if (ready) await ready; const b = await readBody(req, 500000); const n = await onSignal(b.items); j(200, { ok: true, alerted: n }); return true;
  }
  j(404, {}); return true;
}

module.exports = { init, handle };
