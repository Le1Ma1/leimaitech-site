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
  const key = Buffer.from(HASH_KEY, 'utf8');
  const iv  = Buffer.from(HASH_IV , 'utf8');
  if (key.length !== 32 || iv.length !== 16) {
    return { ok: false, error: 'bad key/iv length' };
  }

  // 判斷密文格式：純 16 進位字串則視為 hex，否則當作 base64
  const fmt = /^[0-9a-fA-F]+$/.test(enc) ? 'hex' : 'base64';
  let cipherBuf;
  try {
    cipherBuf = Buffer.from(enc, fmt);
  } catch {
    return { ok: false, error: 'invalid ' + fmt };
  }

  // 第一步：嘗試 autoPadding=true（標準 PKCS7）
  try {
    const d1 = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d1.setAutoPadding(true);
    const out = Buffer.concat([d1.update(cipherBuf), d1.final()]);
    return { ok: true, text: out.toString('utf8'), fmt: fmt + '/auto' };
  } catch {
    // 自動解密失敗，進入 fallback
  }

  // fallback：autoPadding=false，手動處理 PKCS7 及 0x00/0x14
  try {
    const d2 = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d2.setAutoPadding(false);
    let buf = Buffer.concat([d2.update(cipherBuf), d2.final()]);

    // 檢查並移除標準 PKCS7 padding
    const last = buf[buf.length - 1];
    if (last > 0 && last <= 16) {
      const padding = buf.slice(-last);
      if (padding.every(b => b === last)) {
        buf = buf.slice(0, -last);
      }
    }

    // 處理 NewebPay 常見的非標準尾巴 0x00、0x14
    while (buf.length && (buf[buf.length - 1] === 0x00 || buf[buf.length - 1] === 0x14)) {
      buf = buf.slice(0, -1);
    }

    return { ok: true, text: buf.toString('utf8'), fmt: fmt + '/manual' };
  } catch (err) {
    return { ok: false, error: 'decrypt error: ' + err.message };
  }
}

/* AES 加密（供 AlterStatus 用） */
function aesEncrypt(obj, key, iv){
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key,'utf8'), Buffer.from(iv,'utf8'));
  let enc = cipher.update(qs.stringify(obj), 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
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

/* ===== API：register ===== */
app.post('/api/register', async (req, res) => {
  try{
    const { userId, displayName, email, phone } = req.body || {};
    if (!isLineUserId(userId)) return res.status(400).json({ error: '請用 LINE 開啟並取得 LINE userId 後再註冊' });

    const { data: existed, error: selErr } =
      await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (selErr) return res.status(500).json({ error: 'db_select_user' });

    if (!existed) {
      const { error: insErr } = await supabase.from('users').insert([{
        id:userId, display_name:displayName||null, email:email||null, phone:phone||null
      }]);
      if (insErr) return res.status(500).json({ error: 'db_insert_user' });
      console.log(`[REGISTER] 新增用戶: ${userId}`);
    } else {
      console.log(`[REGISTER] 已存在: ${userId}`);
    }
    res.json({ ok:true, userId });
  }catch(e){ console.error('[REGISTER] error', e); res.status(500).json({ error: 'Server error' }); }
});

/* ===== API：subscribe（建單）===== */
app.post('/api/subscribe', async (req, res) => {
  try{
    const { userId, plan='pro', period='month', email } = req.body || {};
    if (!isLineUserId(userId)) return res.status(400).json({ error: '缺少有效的 LINE userId' });

    const { data:user, error:selErr } =
      await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (selErr) return res.status(500).json({ error: 'db_select_user' });
    if (!user) {
      const { error: insErr } = await supabase.from('users').insert([{ id:userId, email:email||null }]);
      if (insErr) return res.status(400).json({ error: '用戶未註冊' });
    }

    const Amt = period === 'year' ? 1999 : 199;
    const now = new Date();
    const trialDays = 10;
    const trialEnd = addDays(now, trialDays);
    const firstChargeDate = trialEnd;

    const PeriodType = (period === 'year') ? 'Y' : 'M';
    const PeriodPoint = PeriodType === 'M'
      ? String(firstChargeDate.getDate()).padStart(2,'0')
      : `${String(firstChargeDate.getMonth()+1).padStart(2,'0')}${String(firstChargeDate.getDate()).padStart(2,'0')}`;

    const order_no = `LMAI${Date.now()}${Math.floor(Math.random()*1000)}`;
    const { error: orderErr } = await supabase.from('orders').insert([{
      order_no, user_id:userId, plan, period, status:'pending',
      amount:Amt, currency:'TWD', email:email||null,
      trial_days:trialDays, trial_start:now.toISOString(), trial_end:trialEnd.toISOString(),
      first_charge_date: ymd(firstChargeDate),
      period_type: PeriodType, period_point: PeriodPoint,
      created_at: now.toISOString(),
    }]);
    if (orderErr) return res.status(500).json({ error:'db_insert_order' });

    console.log(`[SUBSCRIBE] 建單: ${order_no} LINE:${userId} Amt:${Amt} 首扣:${ymd(firstChargeDate)} PType:${PeriodType} PPoint:${PeriodPoint}`);
    res.json({ message:'訂單已建立', order_no });
  }catch(e){ console.error('[SUBSCRIBE] error', e); res.status(500).json({ error: 'Server error' }); }
});

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

/* ===== 查單 ===== */
app.get('/api/order-status', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ error: 'missing order_no' });

  // 查 order
  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
  if (!order) return res.status(404).json({ status: 'not_found' });

  // 查 subscription
  const { data: sub } = await supabase.from('subscriptions').select('*').eq('user_id', order.user_id).maybeSingle();

  // 判斷用戶友善狀態
  let userStatus = '等待付款';
  if (sub) {
    switch (sub.status) {
      case 'trialing': userStatus = '試用中'; break;
      case 'paid':   userStatus = '使用中'; break;
      case 'past_due': userStatus = '逾期寬限'; break;
      case 'canceled': userStatus = '已取消'; break;
      case 'expired':  userStatus = '已過期'; break;
    }
  } else if (order.status === 'paid') {
    userStatus = '使用中';
  }

  res.json({
    status: order.status,
    userStatus,   // ✅ 用戶友善的狀態字串
    order,
    subscription: sub || null
  });
});

/* ===== Webhook：定期定額 Notify ===== */
app.post('/api/period-webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const ct = req.headers['content-type'] || '';
  const rawText = req.body instanceof Buffer ? req.body.toString('utf8') : '';
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

    const enc = (payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '').trim();
    console.log('[WEBHOOK]', { ct, rawLen: rawText.length, keys: Object.keys(payload), hasEnc: !!enc });
    if (!enc) { 
      console.warn('[WEBHOOK] 缺 Period'); 
      return res.status(200).send('IGNORED'); 
    }

    // 存 webhook event
    const eventHash = crypto.createHash('sha256').update(enc).digest('hex');
    await supabase.from('webhook_events').upsert([{
      event_source: 'newebpay_period',
      event_hash: eventHash,
      raw_enc: enc,
      signature: payload.TradeSha || payload.TradeSHA || null,
      processed: false,
      payload: { enc_len: enc.length }
    }], { onConflict: 'event_hash' });

    // 嘗試解密
    let decoded;
    try {
      decoded = aesDecrypt(enc);
      if (!decoded.ok) throw new Error(decoded.error || 'bad decrypt');
    } catch (e) {
      console.warn('[WEBHOOK] decrypt failed', e);
      await supabase.from('webhook_events').update({
        payload: { decrypt_ok:false, enc_len:enc.length }
      }).eq('event_hash', eventHash);
      return res.status(200).send('IGNORED');
    }

    // 清理字串尾端控制字元
    let cleanText = decoded.text.replace(/[\x00-\x1F]+$/g, '');
    let result;
    try { result = JSON.parse(cleanText); }
    catch { result = qs.parse(cleanText); }

    console.log('[WEBHOOK] decoded ok (fmt=' + decoded.fmt + ') =>', result);

    // === 取出交易資料 ===
    const r = result?.Result || {};
    const orderNo = r.MerchantOrderNo;
    const periodNo = r.PeriodNo || null;
    const tradeNo  = r.TradeNo   || null;
    const authCode = r.AuthCode  || null;
    const amount   = Number(r.PeriodAmt || 0);
    const paidAt   = r.AuthTime ? new Date(
      r.AuthTime.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z')
    ) : new Date();
    const success  = result?.Status === 'SUCCESS' && r.RespondCode === '00';

    // === 更新 orders ===
    let { data: orderRow } = await supabase.from('orders').select('*').eq('order_no', orderNo).maybeSingle();
    console.log('[WEBHOOK] order lookup:', { orderNo, orderRow });

    if (orderRow) {
      const { error: updErr } = await supabase.from('orders').update({
        status: success ? 'paid' : 'failed',
        paid_at: success ? new Date().toISOString() : null,
        newebpay_period_no: periodNo,
        raw_response: result
      }).eq('order_no', orderNo);

      if (updErr) console.error('[WEBHOOK] update orders failed:', updErr);
      else console.log('[WEBHOOK] order updated:', orderNo, '->', success ? 'paid' : 'failed');
    }

    // === 成功才進 subscriptions / transactions / whitelist ===
    if (success && orderRow) {
      const nextChargeDate = (r.DateArray || '').split(',')[0] || null;

      // upsert subscription
      const { error: subErr } = await supabase.from('subscriptions').upsert([{
        user_id: orderRow.user_id,
        plan: orderRow.plan,
        period: orderRow.period,
        status: 'active',
        trial_start: orderRow.trial_start,
        trial_end: orderRow.trial_end,
        current_period_start: new Date().toISOString(),
        current_period_end: nextChargeDate,
        period_type: orderRow.period_type,
        period_point: orderRow.period_point,
        period_times: orderRow.period_times,
        gateway: 'newebpay',
        gateway_period_no: periodNo,
        updated_at: new Date().toISOString()
      }], { onConflict: 'user_id' });
      if (subErr) console.error('[WEBHOOK] upsert subscription failed:', subErr);
      else console.log('[WEBHOOK] subscription upserted for', orderRow.user_id);

      // insert transaction
      const { error: txErr } = await supabase.from('transactions').insert([{
        user_id: orderRow.user_id,
        order_no: orderNo,
        type: 'initial',
        status: 'succeeded',
        amount: amount,
        currency: 'TWD',
        gateway_trade_no: tradeNo,
        gateway_auth_code: authCode,
        paid_at: paidAt.toISOString(),
        gateway: 'newebpay',
        raw_payload: result
      }]);
      if (txErr) console.error('[WEBHOOK] insert transaction failed:', txErr);
      else console.log('[WEBHOOK] transaction inserted:', tradeNo);

      // ✅ 插入 bot_whitelist 前檢查 plan_code 是否存在
      const { data: planDef } = await supabase.from('subscription_plans')
        .select('plan_code,tier,period,period_months')
        .eq('plan_code', orderRow.plan)
        .maybeSingle();

      if (!planDef) {
        console.error(`[WEBHOOK] skip whitelist, plan_code not found: ${orderRow.plan}`);
      } else {
        const { error: wlErr } = await supabase.from('bot_whitelist').upsert([{
          user_id: orderRow.user_id,
          provider: 'line',
          plan_code: planDef.plan_code,
          tier: planDef.tier,
          period: planDef.period,
          period_months: planDef.period_months,
          order_no: orderNo,
          period_no: periodNo,
          access_until: nextChargeDate,
          status: 'active',
          updated_at: new Date().toISOString()
        }], { onConflict: 'user_id' });

        if (wlErr) console.error('[WEBHOOK] upsert whitelist failed:', wlErr);
        else console.log('[WEBHOOK] whitelist updated:', orderRow.user_id);
      }
    }

    // update webhook_events
    await supabase.from('webhook_events').update({
      payload: { ...result, decrypt_ok: true },
      processed: true
    }).eq('event_hash', eventHash);

    return res.status(200).send('OK');
  } catch (e) {
    console.error('[WEBHOOK] error', e);
    return res.status(200).send('IGNORED');
  }
});

// ===== 取消訂閱 =====
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!isLineUserId(userId)) return res.status(400).json({ error: '缺少有效的 LINE userId' });

    // 找到訂閱
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['trialing','active','past_due'])
      .maybeSingle();

    if (!sub) return res.status(404).json({ error: '沒有可取消的訂閱' });
    if (!sub.gateway_period_no) return res.status(400).json({ error: '缺少委託單號，無法取消' });

    // ===== 呼叫藍新 AlterStatus API =====
    const payload = {
      RespondType: 'JSON',
      Version: '1.0',
      TimeStamp: Math.floor(Date.now()/1000),
      MerOrderNo: `cancel_${Date.now()}`, // 商店端自定取消單號
      PeriodNo: sub.gateway_period_no,
      AlterType: 'terminate' // 終止
    };
    const enc = aesEncrypt(payload, process.env.HASH_KEY, process.env.HASH_IV);

    const form = new URLSearchParams({
      MerchantID_: process.env.MERCHANT_ID,
      PostData_: enc
    });

    const resp = await fetch(`${NEWEBPAY_BASE}/MPG/period/AlterStatus`, {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const text = await resp.text();
    console.log('[CANCEL RAW]', text);

    // === DB 更新 ===
    await supabase.from('subscriptions')
      .update({ status: 'canceled', updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    await supabase.from('orders')
      .update({ status: 'canceled' })
      .eq('user_id', userId);

    await supabase.from('transactions').insert([{
      order_no: sub.latest_invoice_no || null,
      user_id: userId,
      subscription_id: sub.id,
      type: 'refund',
      status: 'canceled',
      gateway: 'newebpay',
      raw_payload: { cancel_response: text }
    }]);

    // 移除 LINE 白名單
    await callBot(process.env.BOT_REMOVE_URL, {
      provider: 'line',
      user_id: userId,
      reason: 'canceled'
    }, userId);

    res.json({ ok: true, message: '訂閱已取消' });
  } catch (e) {
    console.error('[CANCEL ERROR]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ===== 每日對帳 ===== */
app.post('/cron/reconcile', async (req, res) => {
  if ((req.query.token || '') !== process.env.CRON_TOKEN) return res.sendStatus(403);
  const now = Date.now(), graceMs = GRACE_DAYS * 86400000;

  const { data: subs, error } = await supabase
    .from('subscriptions')
    .select('user_id,status,current_period_end');

  if (error) { console.error('[CRON] db error', error); return res.status(500).json({ error: 'db' }); }

  let removed = 0;
  for (const s of subs || []) {
    const end = s.current_period_end ? new Date(s.current_period_end).getTime() : 0;
    const keep = (s.status === 'trialing' || s.status === 'active' || s.status === 'past_due')
              && (end + graceMs > now);
    if (!keep) {
      const ok = await callBot(process.env.BOT_REMOVE_URL, {
        provider: 'line',
        user_id: s.user_id,
        reason: s.status === 'canceled' ? 'canceled' : 'expired'
      }, s.user_id);
      if (ok) removed++;
    }
  }
  res.json({ ok:true, checked:(subs||[]).length, removed, grace_days:GRACE_DAYS });
});

/* ===== 健康檢查 ===== */
app.get('/api/health', (req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

app.listen(PORT, () => console.log(`Server on :${PORT}`));
