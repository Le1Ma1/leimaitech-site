'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const qs = require('qs');
const crypto = require('crypto');
const path = require('path');
const supabase = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

/* ===== 環境設定 ===== */
const NEWEBPAY_BASE = (process.env.NEWEBPAY_BASE || 'https://core.newebpay.com').trim();
const PERIOD_ENDPOINT = `${NEWEBPAY_BASE}/MPG/period`;
const HASH_KEY = (process.env.HASH_KEY || '').trim();
const HASH_IV  = (process.env.HASH_IV  || '').trim();
const BOT_TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS || 4000);
const GRACE_DAYS     = Number(process.env.GRACE_DAYS || 3);

/* ===== 啟動自檢 ===== */
(function bootCheck(){
  const k = Buffer.from(HASH_KEY, 'utf8');
  const v = Buffer.from(HASH_IV , 'utf8');
  console.log('[BOOT] RAW', JSON.stringify(HASH_KEY), JSON.stringify(HASH_IV));
  console.log('[BOOT]', {
    base: NEWEBPAY_BASE,
    merchant: process.env.MERCHANT_ID || '(unset)',
    keyBytes: k.length,
    ivBytes: v.length
  });
  if (k.length !== 32 || v.length !== 16) {
    console.error('[BOOT] HASH_KEY/HASH_IV 長度不正確（需 32/16 bytes utf8）。');
  }
})();

/* ===== 日誌 + reqId ===== */
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  res.setHeader('X-Request-Id', req.requestId);
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        reqId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - t0
      }));
    } catch {}
  });
  next();
});

/* ===== CORS / Parser / 靜態 ===== */
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com',
    'https://leimaitech-site.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]
}));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

/* ===== 工具 ===== */
const isLineUserId = s => typeof s === 'string' && /^U[a-f0-9]{32}$/i.test(s);
const sha256U = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
const addDays = (d, n)=>{ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; };
const ymd = d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

function hmac(body){
  return crypto.createHmac('sha256', process.env.BOT_SECRET || '').update(body).digest('hex');
}
async function callBot(url, payload, idemKey){
  if (!url) return false;
  const body = JSON.stringify({ ts: Math.floor(Date.now()/1000), ...payload });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': hmac(body),
      'X-Idempotency-Key': idemKey || payload.order_no || payload.user_id
    },
    body,
    signal: AbortSignal.timeout(BOT_TIMEOUT_MS)
  });
  return res.ok;
}

/* multipart 解析 */
function parseMultipart(rawText, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) return {};
  const boundary = `--${m[1]}`;
  const list = rawText.split(boundary);
  const out = {};
  for (const part of list) {
    if (!/Content-Disposition/i.test(part)) continue;
    const nameMatch = /name="([^"]+)"/i.exec(part);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const body = part.slice(idx + 4);
    const endIdx = body.lastIndexOf('\r\n');
    out[name] = (endIdx >= 0 ? body.slice(0, endIdx) : body);
  }
  return out;
}

/* AES 解密 */
function aesDecrypt(enc) {
  const k = Buffer.from(HASH_KEY, 'utf8');
  const v = Buffer.from(HASH_IV , 'utf8');
  if (k.length !== 32 || v.length !== 16) throw new Error('bad key/iv length');

  const decipher = crypto.createDecipheriv('aes-256-cbc', k, v);
  decipher.setAutoPadding(true);

  let decoded = Buffer.concat([
    decipher.update(Buffer.from(enc, 'hex')),
    decipher.final()
  ]);

  return { ok:true, text: decoded.toString('utf8'), fmt:'hex' };
}

/* ===== 顯式頁面 ===== */
const send = p => (req, res) => res.sendFile(path.join(__dirname, p));
app.get(['/subscribe', '/subscribe/'], send('subscribe.html'));
app.get(['/payment-result', '/payment-result/', '/payment-result.html'], send('payment-result.html'));
app.get(['/crypto-linebot', '/crypto-linebot/'], send('crypto-linebot/index.html'));

/* ===== Return：POST → 303 帶上 ?order_no ===== */
app.post(
  ['/payment-result', '/payment-result.html'],
  express.urlencoded({ extended: false, limit: '1mb' }),
  (req, res) => {
    const orderNo =
      req.body?.MerOrderNo ||
      req.body?.MerchantOrderNo ||
      req.body?.Result?.MerOrderNo ||
      req.body?.order_no ||
      req.query?.order_no || '';
    console.log('[PAYMENT RESULT POST]', { bodyKeys: Object.keys(req.body || {}), query: req.query, orderNo });
    const q = orderNo ? `?order_no=${encodeURIComponent(orderNo)}` : '';
    res.redirect(303, `/payment-result.html${q}`);
  }
);

/* ===== Webhook：定期定額 Notify ===== */
app.post('/api/period-webhook', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const ct = req.headers['content-type'] || '';
  const rawText = typeof req.body === 'string' ? req.body : '';
  try {
    let payload = {};
    if (ct.startsWith('application/x-www-form-urlencoded')) {
      payload = qs.parse(rawText);
    } else if (ct.startsWith('multipart/form-data')) {
      payload = parseMultipart(rawText, ct);
    } else if (ct.startsWith('application/json')) {
      try { payload = JSON.parse(rawText); } catch { payload = {}; }
    } else {
      payload = qs.parse(rawText);
    }

    let enc = (payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '').trim();
    try { enc = decodeURIComponent(enc); } catch {} // <-- 加上 URL decode
    console.log('[WEBHOOK]', { ct, rawLen: rawText.length, keys: Object.keys(payload), hasEnc: !!enc });
    if (enc) {
      console.log('[WEBHOOK enc head]', enc.length, 'head:', enc.slice(0,100), 'tail:', enc.slice(-100));
    }
    if (!enc) { 
      console.warn('[WEBHOOK] 缺 Period'); 
      return res.status(200).send('IGNORED'); 
    }

    const eventHash = crypto.createHash('sha256').update(enc).digest('hex');
    await supabase.from('webhook_events').upsert([{
      event_source: 'newebpay_period',
      event_hash: eventHash,
      raw_enc: enc,
      signature: payload.TradeSha || payload.TradeSHA || null,
      processed: false,
      payload: { enc_len: enc.length }
    }], { onConflict: 'event_hash' });

    let decoded;
    try {
      decoded = aesDecrypt(enc);
      if (!decoded.ok) throw new Error('bad decrypt');
    } catch (e) {
      console.warn('[WEBHOOK] decrypt failed', e.message);
      await supabase.from('webhook_events').update({
        payload: { decrypt_ok:false, error: e.message, enc_is_hex:/^[0-9a-fA-F]+$/.test(enc), enc_len:enc.length }
      }).eq('event_hash', eventHash);
      return res.status(200).send('IGNORED');
    }

    let result; 
    try { result = JSON.parse(decoded.text); } catch { result = qs.parse(decoded.text); }
    console.log('[WEBHOOK] decoded ok (fmt=' + decoded.fmt + ') =>', result);
    await supabase.from('webhook_events').update({ payload: { ...result, decrypt_ok:true } }).eq('event_hash', eventHash);

    return res.status(200).send('OK');
  } catch (e) {
    console.error('[WEBHOOK] error', e);
    return res.status(200).send('IGNORED');
  }
});

/* ===== 健康檢查 ===== */
app.get('/api/health', (req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

app.listen(PORT, () => console.log(`Server on :${PORT}`));
