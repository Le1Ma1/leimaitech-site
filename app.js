// app.js
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

/* ---------- Env helpers ---------- */
const envStr = (k, d='') => (process.env[k] ?? d).toString().trim();
const NEWEBPAY_BASE = envStr('NEWEBPAY_BASE') || 'https://ccore.newebpay.com';
const PERIOD_ENDPOINT = `${NEWEBPAY_BASE}/MPG/period`;
const MERCHANT_ID = envStr('MERCHANT_ID');
const HASH_KEY_RAW = envStr('HASH_KEY');
const HASH_IV_RAW  = envStr('HASH_IV');

function keyIv() {
  // 固定長度，避免末尾空白或複製錯誤造成長度不符
  const k = Buffer.alloc(32, 0);
  const i = Buffer.alloc(16, 0);
  Buffer.from(HASH_KEY_RAW, 'utf8').copy(k);
  Buffer.from(HASH_IV_RAW,  'utf8').copy(i);
  return { k, i };
}

/* ---------- Logger with reqId ---------- */
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

/* ---------- CORS ---------- */
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com',
    'https://leimaitech-site.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]
}));

/* ---------- Parsers ---------- */
// 只給 /api/* 用 JSON，webhook 另外在路由層吃 raw
app.use(bodyParser.json({ limit: '1mb' }));

/* ---------- Static ---------- */
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

/* ---------- Utils ---------- */
const isLineUserId = s => typeof s === 'string' && /^U[a-f0-9]{32}$/i.test(s);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate()+n); return x; };
const yyyymmdd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const sha256U = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();

function aesEncrypt(obj) {
  const { k, i } = keyIv();
  const cipher = crypto.createCipheriv('aes-256-cbc', k, i);
  let enc = cipher.update(qs.stringify(obj), 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

function isHex(s){ return typeof s==='string' && s.length%2===0 && /^[0-9a-f]+$/i.test(s); }
function isB64(s){ return typeof s==='string' && /^[A-Za-z0-9+/=]+$/.test(s) && s.length%4===0; }

function aesDecryptSmart(enc) {
  const { k, i } = keyIv();
  const tryHex = () => {
    const d = crypto.createDecipheriv('aes-256-cbc', k, i);
    d.setAutoPadding(true);
    let out = d.update(enc, 'hex', 'utf8'); out += d.final('utf8'); return out;
  };
  const tryB64 = () => {
    const d = crypto.createDecipheriv('aes-256-cbc', k, i);
    d.setAutoPadding(true);
    let out = d.update(enc, 'base64', 'utf8'); out += d.final('utf8'); return out;
  };

  if (isHex(enc)) return tryHex();
  if (isB64(enc)) return tryB64();

  // 不像 hex/b64，兩種都嘗試
  try { return tryHex(); } catch {}
  return tryB64();
}

/* ---------- BOT helpers ---------- */
const GRACE_DAYS = Number(envStr('GRACE_DAYS') || 3);
function hmac(body){
  return crypto.createHmac('sha256', envStr('BOT_SECRET') || '')
               .update(body).digest('hex');
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
    signal: AbortSignal.timeout(Number(envStr('BOT_TIMEOUT_MS') || 4000))
  });
  return res.ok;
}

/* ---------- Pages ---------- */
const send = p => (req, res) => res.sendFile(path.join(__dirname, p));
app.get(['/subscribe', '/subscribe/'], send('subscribe.html'));
app.get(['/payment-result', '/payment-result/', '/payment-result.html'], send('payment-result.html'));
app.get(['/crypto-linebot', '/crypto-linebot/'], send('crypto-linebot/index.html'));

/* POST /payment-result → 303 帶 order_no 回前端 */
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

/* ---------- API: register ---------- */
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

/* ---------- API: subscribe (create order) ---------- */
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
      first_charge_date: yyyymmdd(firstChargeDate),
      period_type: PeriodType, period_point: PeriodPoint,
      created_at: now.toISOString(),
    }]);
    if (orderErr) return res.status(500).json({ error:'db_insert_order' });

    console.log(`[SUBSCRIBE] 建單: ${order_no} LINE:${userId} Amt:${Amt} 首扣:${yyyymmdd(firstChargeDate)} PType:${PeriodType} PPoint:${PeriodPoint}`);
    res.json({ message:'訂單已建立', order_no });
  }catch(e){ console.error('[SUBSCRIBE] error', e); res.status(500).json({ error: 'Server error' }); }
});

/* ---------- API: pay form (redirect to NewebPay) ---------- */
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
      NotifyURL: envStr('PERIOD_NOTIFY_URL'),
      ReturnURL: `${envStr('RETURN_URL_BASE') || 'https://leimaitech.com'}/payment-result.html?order_no=${order_no}`
    };

    const postDataEnc = aesEncrypt(periodInfoObj);

    console.log('[PERIOD PAY] Params:', periodInfoObj);
    res.send(`
      <form id="periodPayForm" method="POST" action="${PERIOD_ENDPOINT}">
        <input type="hidden" name="MerchantID_" value="${MERCHANT_ID}">
        <input type="hidden" name="PostData_" value="${postDataEnc}">
      </form>
      <script>document.getElementById('periodPayForm').submit();</script>
    `);
  }catch(e){ console.error('[PERIOD PAY] error', e); res.status(500).send('Server error'); }
});

/* ---------- API: order status ---------- */
app.get('/api/order-status', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ error: 'missing order_no' });
  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status, order });
});

/* ---------- API: webhook (Period) ---------- */
app.post(
  '/api/period-webhook',
  express.text({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const ct = req.headers['content-type'] || '';
    const rawText = typeof req.body === 'string' ? req.body : '';
    try {
      let payload = {};
      if (rawText) payload = qs.parse(rawText);
      else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) payload = req.body;
      else if (req.query && Object.keys(req.query).length) payload = req.query;

      console.log('[WEBHOOK] ct=', ct, 'rawLen=', rawText.length, 'keys=', Object.keys(payload));

      const enc = payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '';
      if (!enc) { console.warn('[WEBHOOK] 缺 enc'); return res.status(200).send('IGNORED'); }

      // 事件指紋
      const eventHash = crypto.createHash('sha256').update(enc).digest('hex');
      await supabase.from('webhook_events').upsert([{
        event_source: 'newebpay_period',
        event_hash: eventHash,
        signature: payload.TradeSha || payload.TradeSHA || null,
        processed: false
      }], { onConflict: 'event_hash' });

      // 驗證 TradeSha（不同欄位名都試一次）
      const providedSha = payload.TradeSha || payload.TradeSHA || '';
      if (providedSha) {
        const key = HASH_KEY_RAW, iv = HASH_IV_RAW;
        const ok = [
          `HashKey=${key}&${enc}&HashIV=${iv}`,                 // 未帶欄位名
          `HashKey=${key}&PostData_=${enc}&HashIV=${iv}`,       // MPG
          `HashKey=${key}&TradeInfo=${enc}&HashIV=${iv}`,       // 一次付
          `HashKey=${key}&Period=${enc}&HashIV=${iv}`           // 定期定額
        ].some(s => sha256U(s) === providedSha);
        if (!ok) {
          console.warn('[WEBHOOK] SHA mismatch');
          await supabase.from('webhook_events').update({
            payload: { sha_mismatch: true, providedSha, preview: enc.slice(0, 64) }
          }).eq('event_hash', eventHash);
          return res.status(200).send('IGNORED');
        }
      }

      // 解密（hex/base64 皆可）
      let decodedText = '';
      try {
        decodedText = aesDecryptSmart(enc);
      } catch (e) {
        console.error('[WEBHOOK] decrypt failed');
        await supabase.from('webhook_events').update({
          payload: { decrypt_failed: true, is_hex: isHex(enc), is_b64: isB64(enc), preview: enc.slice(0, 64) }
        }).eq('event_hash', eventHash);
        return res.status(200).send('IGNORED');
      }

      let result; try { result = JSON.parse(decodedText); } catch { result = qs.parse(decodedText); }
      console.log('[WEBHOOK] decoded:', result);

      await supabase.from('webhook_events').update({ payload: result }).eq('event_hash', eventHash);

      const merOrderNo =
        result?.MerOrderNo || result?.MerchantOrderNo ||
        result?.Result?.MerOrderNo || result?.Result?.MerchantOrderNo;
      if (!merOrderNo) { console.warn('[WEBHOOK] 無 MerOrderNo'); return res.status(200).send('IGNORED'); }

      const respondCode = result?.Result?.RespondCode || result?.RespondCode || result?.ReturnCode || result?.RtnCode;
      const status = String(result?.Status || '').toUpperCase();
      const isSuccess = status === 'SUCCESS' || respondCode === '00';
      const periodNo = result?.PeriodNo || result?.Result?.PeriodNo || result?.Result?.PeriodInfo || null;

      if (isSuccess) {
        await supabase.from('orders').update({ status: 'paid', newebpay_period_no: periodNo || null, paid_at: new Date().toISOString() }).eq('order_no', merOrderNo);
        const { data: order } = await supabase.from('orders').select('*').eq('order_no', merOrderNo).maybeSingle();

        if (order) {
          const subPayload = {
            user_id: order.user_id,
            plan: 'pro',
            period: order.period,
            status: 'trialing',
            trial_start: order.trial_start,
            trial_end: order.trial_end,
            current_period_start: order.trial_start,
            current_period_end: order.trial_end,
            period_type: order.period_type,
            period_point: order.period_point,
            period_times: 99,
            gateway: 'newebpay',
            gateway_period_no: periodNo
          };

          const { data: existing } = await supabase
            .from('subscriptions')
            .select('id,status')
            .eq('user_id', order.user_id)
            .eq('plan','pro')
            .in('status',['trialing','active','past_due'])
            .maybeSingle();

          if (existing?.id) await supabase.from('subscriptions').update(subPayload).eq('id', existing.id);
          else await supabase.from('subscriptions').insert([subPayload]);

          await callBot(envStr('BOT_UPSERT_URL'), {
            provider: 'line',
            user_id: order.user_id,
            plan: 'pro',
            order_no: merOrderNo,
            period_no: periodNo || null,
            access_until: order.trial_end
          }, eventHash);
        }

        await supabase.from('transactions').insert([{
          order_no: merOrderNo,
          type: 'initial',
          status: 'succeeded',
          gateway: 'newebpay',
          gateway_trade_no: periodNo,
          paid_at: new Date().toISOString(),
          raw_payload: result
        }]);
        console.log(`[WEBHOOK] OK ${merOrderNo} → paid / trialing`);
      } else {
        await supabase.from('orders').update({ status: 'failed' }).eq('order_no', merOrderNo);
        await supabase.from('transactions').insert([{ order_no: merOrderNo, type:'initial', status:'failed', raw_payload: result }]);
        console.log(`[WEBHOOK] FAIL ${merOrderNo}`);
      }

      await supabase.from('webhook_events').update({ processed: true }).eq('event_hash', eventHash);
      return res.status(200).send('OK');
    } catch (e) {
      console.error('[WEBHOOK] error', e);
      return res.status(200).send('IGNORED');
    }
  }
);

/* ---------- CRON reconcile ---------- */
app.post('/cron/reconcile', async (req, res) => {
  if ((req.query.token || '') !== envStr('CRON_TOKEN')) return res.sendStatus(403);
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
      const ok = await callBot(envStr('BOT_REMOVE_URL'), {
        provider: 'line',
        user_id: s.user_id,
        reason: s.status === 'canceled' ? 'canceled' : 'expired'
      }, s.user_id);
      if (ok) removed++;
    }
  }
  res.json({ ok: true, checked: (subs || []).length, removed, grace_days: GRACE_DAYS });
});

/* ---------- Test endpoints ---------- */
// 健康檢查
app.get('/api/health', (req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

// 強制把訂單設為已付（測試用）
app.post('/api/mock/force-paid', async (req, res) => {
  if ((req.query.token || '') !== envStr('CRON_TOKEN')) return res.sendStatus(403);
  const order_no = req.query.order_no || req.body?.order_no;
  if (!order_no) return res.status(400).json({ error: 'missing order_no' });

  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  await supabase.from('orders').update({ status:'paid', paid_at: new Date().toISOString() }).eq('order_no', order_no);
  await supabase.from('transactions').insert([{
    order_no, user_id: order.user_id, type: 'initial', status: 'succeeded',
    amount: order.amount, currency: order.currency, paid_at: new Date().toISOString(),
    raw_payload: { mocked: true }
  }]);

  res.json({ ok:true, order_no, forced:true });
});

/* ---------- Start ---------- */
app.listen(PORT, () => console.log(`Server on :${PORT}`));
