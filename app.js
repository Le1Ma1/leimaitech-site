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

const NEWEBPAY_BASE = process.env.NEWEBPAY_BASE || 'https://ccore.newebpay.com';
const PERIOD_ENDPOINT = `${NEWEBPAY_BASE}/MPG/period`;

const HASH_KEY = (process.env.HASH_KEY || '').trim();
const HASH_IV  = (process.env.HASH_IV  || '').trim();
const ADMIN_FORCE_TOKEN = process.env.ADMIN_FORCE_TOKEN || '';

// ===== 日誌與 Request ID =====
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

app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com',
    'https://leimaitech-site.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]
}));

// 只啟用 JSON（供 /api/* 使用）
app.use(bodyParser.json({ limit: '1mb' }));

// 靜態檔 + .html fallback（本專案根目錄）
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ===== 小工具 =====
function addDays(d, days){ const x=new Date(d.getTime()); x.setDate(x.getDate()+days); return x; }
function yyyymmdd(date){ const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,'0'), d=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; }
function aesEncrypt(obj, key, iv){
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key,'utf8'), Buffer.from(iv,'utf8'));
  let enc = cipher.update(qs.stringify(obj), 'utf8', 'hex'); enc += cipher.final('hex'); return enc;
}
const isHex = s => /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0;
function aesDecryptSmart(encStr, key, iv){
  const k = Buffer.from(key, 'utf8');
  const i = Buffer.from(iv,  'utf8');
  const tries = isHex(encStr) ? ['hex','base64'] : ['base64','hex'];
  let lastErr;
  for (const enc of tries){
    try{
      const decipher = crypto.createDecipheriv('aes-256-cbc', k, i);
      decipher.setAutoPadding(true);
      let out = decipher.update(Buffer.from(encStr, enc));
      out = Buffer.concat([out, decipher.final()]);
      return { text: out.toString('utf8'), encType: enc };
    }catch(e){ lastErr = e; }
  }
  const err = new Error('bad decrypt');
  err.cause = lastErr;
  throw err;
}
const isLineUserId = s => typeof s === 'string' && /^U[a-f0-9]{32}$/i.test(s);
const sha256U = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();

// ===== BOT 介接 =====
const GRACE_DAYS = Number(process.env.GRACE_DAYS || 3);
function hmac(body){
  return crypto.createHmac('sha256', process.env.BOT_SECRET || '')
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
    signal: AbortSignal.timeout(Number(process.env.BOT_TIMEOUT_MS || 4000))
  });
  return res.ok;
}

// ===== 顯式對應頁 =====
const send = p => (req, res) => res.sendFile(path.join(__dirname, p));
app.get(['/subscribe', '/subscribe/'], send('subscribe.html'));
app.get(['/payment-result', '/payment-result/', '/payment-result.html'], send('payment-result.html'));
app.get(['/crypto-linebot', '/crypto-linebot/'], send('crypto-linebot/index.html'));

// 結果頁：POST（藍新回跳）→ 303 帶上 ?order_no
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

// ===== 使用者註冊 =====
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

// ===== 建單（支持月/年）=====
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

// ===== 產生定期定額表單（隱收件人；只顯示付款人）=====
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
      ReturnURL: `${process.env.RETURN_URL_BASE || 'https://leimaitech.com'}/payment-result.html?order_no=${order_no}`
    };

    const postDataEnc = aesEncrypt(periodInfoObj, HASH_KEY, HASH_IV);

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

// ===== 訂單狀態查詢（禁快取）=====
app.get('/api/order-status', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ error: 'missing order_no' });
  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status, order });
});

// ===== 定期定額 Webhook（接受任意 Content-Type）=====
app.post(
  '/api/period-webhook',
  express.text({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    let eventHash = null;
    try {
      const ct = req.headers['content-type'] || '';
      const rawText = typeof req.body === 'string' ? req.body : '';
      let payload = {};
      if (rawText) payload = qs.parse(rawText);
      else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) payload = req.body;
      else if (req.query && Object.keys(req.query).length) payload = req.query;

      console.log('[WEBHOOK] ct=', ct, 'rawLen=', rawText.length, 'keys=', Object.keys(payload));

      let enc = (payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '').trim();
      if (!enc) { console.warn('[WEBHOOK] 缺 enc'); return res.status(200).send('IGNORED'); }

      // 先記錄事件（processed=false）
      eventHash = crypto.createHash('sha256').update(enc).digest('hex');
      await supabase.from('webhook_events').upsert([{
        event_source: 'newebpay_period',
        event_hash: eventHash,
        signature: payload.TradeSha || payload.TradeSHA || null,
        processed: false
      }], { onConflict: 'event_hash' });

      // 若不是純 hex，還原空白為 '+'
      if (!isHex(enc)) enc = enc.replace(/ /g, '+');

      const providedSha = payload.TradeSha || payload.TradeSHA || '';
      if (providedSha && HASH_KEY && HASH_IV) {
        const candidates = [
          `HashKey=${HASH_KEY}&PostData_=${enc}&HashIV=${HASH_IV}`,
          `HashKey=${HASH_KEY}&TradeInfo=${enc}&HashIV=${HASH_IV}`,
          `HashKey=${HASH_KEY}&Period=${enc}&HashIV=${HASH_IV}`,
        ];
        const ok = candidates.some(s => sha256U(s) === providedSha);
        if (!ok) console.warn('[WEBHOOK] SHA mismatch (sandbox may omit/alter)');
      }

      // 解密
      let decodedText, encType;
      try {
        const r = aesDecryptSmart(enc, HASH_KEY, HASH_IV);
        decodedText = r.text; encType = r.encType;
      } catch (e) {
        console.error('[WEBHOOK] decrypt failed');
        await supabase.from('webhook_events').update({
          payload: { bad_decrypt:true, enc_len: enc.length, is_hex: isHex(enc), sample: enc.slice(0, 48) }
        }).eq('event_hash', eventHash);
        return res.status(200).send('IGNORED');
      }

      let result; try { result = JSON.parse(decodedText); } catch { result = qs.parse(decodedText); }
      console.log('[WEBHOOK] decoded encType=', encType, 'result keys=', Object.keys(result));

      // 更新事件 payload
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
        await supabase.from('orders').update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          newebpay_period_no: periodNo
        }).eq('order_no', merOrderNo);

        const { data: order } = await supabase.from('orders').select('*').eq('order_no', merOrderNo).maybeSingle();

        if (order) {
          const subPayload = {
            user_id: order.user_id,
            plan: order.plan || 'pro',
            period: order.period,
            status: 'trialing',
            trial_start: order.trial_start,
            trial_end: order.trial_end,
            current_period_start: order.trial_start,
            current_period_end: order.trial_end,
            period_type: order.period_type,
            period_point: order.period_point,
            period_times: order.period_times || 99,
            gateway: 'newebpay',
            gateway_period_no: periodNo
          };

          const { data: existing } = await supabase
            .from('subscriptions')
            .select('id,status')
            .eq('user_id', order.user_id)
            .eq('plan', subPayload.plan)
            .in('status',['trialing','active','past_due'])
            .maybeSingle();

          if (existing?.id) await supabase.from('subscriptions').update(subPayload).eq('id', existing.id);
          else await supabase.from('subscriptions').insert([subPayload]);

          await callBot(process.env.BOT_UPSERT_URL, {
            provider: 'line',
            user_id: order.user_id,
            plan: subPayload.plan,
            order_no: merOrderNo,
            period_no: periodNo || null,
            access_until: order.trial_end
          }, eventHash);
        }

        await supabase.from('transactions').insert([{
          order_no: merOrderNo,
          user_id: (order && order.user_id) || null,
          type: 'initial',
          status: 'succeeded',
          amount: (order && order.amount) || null,
          currency: (order && order.currency) || 'TWD',
          gateway_trade_no: periodNo,
          paid_at: new Date().toISOString(),
          raw_payload: result
        }]);
        console.log(`[WEBHOOK] OK ${merOrderNo} → paid / trialing`);
      } else {
        await supabase.from('orders').update({ status: 'failed' }).eq('order_no', merOrderNo);
        await supabase.from('transactions').insert([{
          order_no: merOrderNo, type:'initial', status:'failed', raw_payload: result
        }]);
        console.log(`[WEBHOOK] FAIL ${merOrderNo}`);
      }

      await supabase.from('webhook_events').update({ processed: true }).eq('event_hash', eventHash);
      return res.status(200).send('OK');
    } catch (e) {
      console.error('[WEBHOOK] error', e);
      if (eventHash) {
        try {
          await supabase.from('webhook_events').update({
            payload: { parse_error: true, note: 'exception', ts: new Date().toISOString() }
          }).eq('event_hash', eventHash);
        } catch {}
      }
      return res.status(200).send('IGNORED');
    }
  }
);

// ===== 每日對帳：過期或取消就移除白名單 =====
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
  res.json({ ok: true, checked: (subs || []).length, removed, grace_days: GRACE_DAYS });
});

// ===== 測試用：強制把訂單設為已付款（需 ADMIN_FORCE_TOKEN）=====
app.post('/admin/force-paid', express.json(), async (req, res) => {
  try{
    const { token, order_no } = req.body || {};
    if (!ADMIN_FORCE_TOKEN || token !== ADMIN_FORCE_TOKEN) return res.sendStatus(403);
    if (!order_no) return res.status(400).json({ error:'missing order_no' });

    const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
    if (!order) return res.status(404).json({ error:'order_not_found' });

    await supabase.from('orders').update({
      status:'paid', paid_at:new Date().toISOString(), newebpay_period_no: order.newebpay_period_no || 'TESTFORCE'
    }).eq('order_no', order_no);

    const subPayload = {
      user_id: order.user_id,
      plan: order.plan || 'pro',
      period: order.period,
      status: 'trialing',
      trial_start: order.trial_start,
      trial_end: order.trial_end,
      current_period_start: order.trial_start,
      current_period_end: order.trial_end,
      period_type: order.period_type,
      period_point: order.period_point,
      period_times: order.period_times || 99,
      gateway: 'newebpay',
      gateway_period_no: order.newebpay_period_no || 'TESTFORCE'
    };

    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id,status')
      .eq('user_id', order.user_id)
      .eq('plan', subPayload.plan)
      .in('status',['trialing','active','past_due'])
      .maybeSingle();

    if (existing?.id) await supabase.from('subscriptions').update(subPayload).eq('id', existing.id);
    else await supabase.from('subscriptions').insert([subPayload]);

    await supabase.from('transactions').insert([{
      order_no: order.order_no,
      user_id: order.user_id,
      type: 'initial',
      status: 'succeeded',
      amount: order.amount,
      currency: order.currency || 'TWD',
      gateway_trade_no: order.newebpay_period_no || 'TESTFORCE',
      paid_at: new Date().toISOString(),
      raw_payload: { forced: true }
    }]);

    res.json({ ok:true, forced:true });
  }catch(e){ console.error('[ADMIN FORCE PAID] error', e); res.status(500).json({ error:'server' }); }
});

// 健康檢查
app.get('/api/health', (req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

app.listen(PORT, () => console.log(`Server on :${PORT}`));
