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

  const tryFmt = (fmt) => {
    const d = crypto.createDecipheriv('aes-256-cbc', k, v);
    d.setAutoPadding(true);
    let out = d.update(enc, fmt, 'utf8'); out += d.final('utf8');
    return out;
  };

  const looksHex = /^[0-9a-fA-F]+$/.test(enc) && enc.length % 2 === 0;
  const order = looksHex ? ['hex','base64'] : ['base64','hex'];
  for (const fmt of order) {
    try { return { ok:true, text: tryFmt(fmt), fmt }; } catch {}
  }
  return { ok:false };
}

/* ===== 產生定期定額表單 ===== */
app.get('/pay', async (req, res) => {
  try{
    const { order_no } = req.query;
    if (!order_no) return res.status(400).send('缺少訂單編號');

    const { data: order, error: selErr } =
      await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
    if (selErr) return res.status(500).send('DB error');
    if (!order) return res.status(404).send('找不到訂單');
    if (!isLineUserId(order.user_id)) return res.status(400).send('缺少有效的 LINE userId');

    const TimeStamp = Math.floor(Date.now()/1000).toString();
    const periodInfoObj = {
      RespondType: 'JSON',
      TimeStamp,
      Version: '1.5',
      LangType: 'zh-Tw',
      MerOrderNo: order_no,
      ProdDesc: 'Leimaitech Pro Subscription',
      PeriodAmt: order.amount,
      PeriodType: order.period_type,
      PeriodPoint: order.period_point,
      PeriodStartType: '1',
      PeriodTimes: 99,
      PayerEmail: order.email || 'test@example.com',
      EmailModify: 1,
      PaymentInfo: 'N',
      OrderInfo: 'N',
      NotifyURL: process.env.PERIOD_NOTIFY_URL,
      ReturnURL: `${(process.env.RETURN_URL_BASE || 'https://api.leimaitech.com').replace(/\/+$/,'')}/payment-result.html?order_no=${order_no}`
    };

    const keyBuf = Buffer.from(HASH_KEY, 'utf8');
    const ivBuf  = Buffer.from(HASH_IV , 'utf8');
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, ivBuf);
    let postDataEnc = cipher.update(qs.stringify(periodInfoObj), 'utf8', 'hex'); 
    postDataEnc += cipher.final('hex');

    console.log('[PERIOD PAY] Params:', periodInfoObj);
    res.send(`
      <form id="periodPayForm" method="POST" action="${PERIOD_ENDPOINT}">
        <input type="hidden" name="MerchantID_" value="${process.env.MERCHANT_ID}">
        <input type="hidden" name="PostData_" value="${postDataEnc}">
      </form>
      <script>document.getElementById('periodPayForm').submit();</script>
    `);
  }catch(e){ console.error('[PERIOD PAY] error', e); res.status(500).send('Server error'); }
});

/* 其餘 API 和 webhook 保持原樣 (register, subscribe, webhook, reconcile, health) */

app.listen(PORT, () => console.log(`Server on :${PORT}`));
