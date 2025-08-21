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

/* =========================
   僅正式站（core.newebpay.com）
   ========================= */
const NEWEBPAY_BASE = process.env.NEWEBPAY_BASE || 'https://core.newebpay.com';
const PERIOD_ENDPOINT = `${NEWEBPAY_BASE}/MPG/period`;

/* ===== 正式金鑰（去除不可見字元）===== */
const HASH_KEY = (process.env.HASH_KEY || '').trim();
const HASH_IV  = (process.env.HASH_IV  || '').trim();

/* ===== 其他設定 ===== */
const BOT_TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS || 4000);
const GRACE_DAYS     = Number(process.env.GRACE_DAYS || 3);

/* ===== 啟動自檢 ===== */
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

(function bootCheck(){
  const keyLen = Buffer.from(HASH_KEY, 'utf8').length;
  const ivLen  = Buffer.from(HASH_IV,  'utf8').length;
  console.log(`[BOOT] NEWEBPAY_BASE=${NEWEBPAY_BASE}`);
  console.log(`[BOOT] MERCHANT_ID=${process.env.MERCHANT_ID || '(unset)'}`);
  console.log(`[BOOT] HASH_KEY bytes=${keyLen}, HASH_IV bytes=${ivLen}`);
  if (NEWEBPAY_BASE.indexOf('core.newebpay.com') === -1) {
    console.warn('[BOOT] 警告：NEWEBPAY_BASE 非正式站（應為 https://core.newebpay.com）');
  }
  if (keyLen !== 32 || ivLen !== 16) {
    console.error('[BOOT] 金鑰長度不正確（AES-256-CBC 要求 key=32 bytes, iv=16 bytes）。請重新複製貼上金鑰/IV，避免不可見字元。');
  }
})();

/* ===== CORS / Body Parsers ===== */
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com',
    'https://leimaitech-site.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]
}));
// 只給 /api/* 用 JSON；不要全域 urlencoded，避免 webhook 解析衝突
app.use(bodyParser.json({ limit: '1mb' }));

/* ===== 靜態頁 ===== */
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

/* ===== 工具 ===== */
const isLineUserId = s => typeof s === 'string' && /^U[a-f0-9]{32}$/i.test(s);
const sha256U = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
const addDays = (d, days)=>{ const x=new Date(d.getTime()); x.setDate(x.getDate()+days); return x; };
const yyyymmdd = d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

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

/* ===== 解析 multipart/form-data（只取純文字欄位，不多做 trim）===== */
function parseMultipart(rawText, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) return {};
  const boundary = `--${m[1]}`;
  const chunks = rawText.split(boundary);
  const out = {};
  for (const chunk of chunks) {
    if (!/Content-Disposition/i.test(chunk)) continue;
    const nameMatch = /name="([^"]+)"/i.exec(chunk);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const idx = chunk.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const body = chunk.slice(idx + 4);
    // 去掉這一 part 尾端的 CRLF（不做 .trim() 以免吃到合法字元）
    const endIdx = body.lastIndexOf('\r\n');
    out[name] = (endIdx >= 0 ? body.slice(0, endIdx) : body);
  }
  return out;
}

/* ===== AES 解密（嘗試 hex 與 base64）===== */
function aesDecryptPeriod(enc, key, iv) {
  const tryOnce = (encFmt) => {
    const cipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key,'utf8'), Buffer.from(iv,'utf8'));
    cipher.setAutoPadding(true);
    let out = cipher.update(enc, encFmt, 'utf8');
    out += cipher.final('utf8');
    return out;
  };
  // 先依樣貌判斷，再互換嘗試
  const looksHex = /^[0-9a-fA-F]+$/.test(enc) && enc.length % 2 === 0;
  const order = looksHex ? ['hex','base64'] : ['base64','hex'];
  for (const fmt of order) {
    try { return { ok:true, text: tryOnce(fmt), fmt }; } catch {}
  }
  return { ok:false };
}

/* ===== 顯式路由（對應靜態頁）===== */
const send = p => (req, res) => res.sendFile(path.join(__dirname, p));
app.get(['/subscribe', '/subscribe/'], send('subscribe.html'));
app.get(['/payment-result', '/payment-result/', '/payment-result.html'], send('payment-result.html'));
app.get(['/crypto-linebot', '/crypto-linebot/'], send('crypto-linebot/index.html'));

/* ===== 藍新前景回跳：POST → 303 帶上 ?order_no ===== */
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

/* ===== 使用者註冊 ===== */
app.post('/api/register', async (req, res) => {
  try{
    const { userId, displayName, email, phone } = req.body || {};
    if (!isLineUserId(userId)) return res.status(400).json({ error: '請用 LINE 開啟並取得 LINE userId 後再註冊' });

    const { data: existed, error: selErr } =
      await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (selErr) return res.status(500).json({ error: 'db_select_user' });

    if (!existed) {
      const { error: insErr } = await supabase.from('users').insert([{ id:userId, display_name:displayName||null, email:email||null, phone:phone||null }]);
      if (insErr) return res.status(500).json({ error: 'db_insert_user' });
      console.log(`[REGISTER] 新增用戶: ${userId}`);
    } else {
      console.log(`[REGISTER] 已存在: ${userId}`);
    }
    res.json({ ok:true, userId });
  }catch(e){ console.error('[REGISTER] error', e); res.status(500).json({ error: 'Server error' }); }
});

/* ===== 建單（支持月/年）===== */
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
      ReturnURL: `${process.env.RETURN_URL_BASE || 'https://leimaitech.com'}/payment-result.html?order_no=${order_no}`
    };

    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(HASH_KEY,'utf8'), Buffer.from(HASH_IV,'utf8'));
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

/* ===== 訂單狀態查詢（禁快取）===== */
app.get('/api/order-status', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ error: 'missing order_no' });
  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).maybeSingle();
  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status, order });
});

/* ===== 定期定額 Webhook ===== */
app.post('/api/period-webhook', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const ct = req.headers['content-type'] || '';
  const rawText = typeof req.body === 'string' ? req.body : '';
  try {
    let payload = {};
    if (ct.startsWith('application/x-www-form-urlencoded')) {
      payload = qs.parse(rawText); // 注意：若為 base64 會有 '+'，qs 會正確保留
    } else if (ct.startsWith('multipart/form-data')) {
      payload = parseMultipart(rawText, ct);
    } else if (ct.startsWith('application/json')) {
      try { payload = JSON.parse(rawText); } catch { payload = {}; }
    } else {
      payload = qs.parse(rawText);
    }

    const enc = payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '';
    console.log('[WEBHOOK]', { ct, rawLen: rawText.length, keys: Object.keys(payload), hasEnc: !!enc });

    if (!enc) {
      console.warn('[WEBHOOK] 缺 Period/TradeInfo');
      return res.status(200).send('IGNORED');
    }

    // 去重：以密文建立 hash
    const eventHash = crypto.createHash('sha256').update(enc).digest('hex');
    await supabase.from('webhook_events').upsert([{
      event_source: 'newebpay_period',
      event_hash: eventHash,
      signature: payload.TradeSha || payload.TradeSHA || null,
      processed: false
    }], { onConflict: 'event_hash' });

    // 驗章（若有）
    const providedSha = payload.TradeSha || payload.TradeSHA || '';
    if (providedSha) {
      const candidates = [
        `HashKey=${HASH_KEY}&${enc}&HashIV=${HASH_IV}`,
        `HashKey=${HASH_KEY}&PostData_=${enc}&HashIV=${HASH_IV}`,
        `HashKey=${HASH_KEY}&TradeInfo=${enc}&HashIV=${HASH_IV}`,
        `HashKey=${HASH_KEY}&Period=${enc}&HashIV=${HASH_IV}`
      ];
      const pass = candidates.some(s => sha256U(s) === providedSha);
      if (!pass) console.warn('[WEBHOOK] SHA mismatch');
    }

    // 解密
    const d = aesDecryptPeriod(enc, HASH_KEY, HASH_IV);
    if (!d.ok) {
      console.warn('[WEBHOOK] decrypt failed');
      await supabase.from('webhook_events').update({
        payload: {
          decrypt_env: 'prod',
          enc_is_hex: /^[0-9a-fA-F]+$/.test(enc),
          enc_len: enc.length,
          head32: enc.slice(0, 32),
          tail32: enc.slice(-32)
        }
      }).eq('event_hash', eventHash);
      return res.status(200).send('IGNORED');
    }

    let result; try { result = JSON.parse(d.text); } catch { result = qs.parse(d.text); }
    console.log('[WEBHOOK] decoded ok (fmt=' + d.fmt + ') =>', result);

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
      await supabase.from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString(), newebpay_period_no: periodNo })
        .eq('order_no', merOrderNo);

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

        await callBot(process.env.BOT_UPSERT_URL, {
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
        user_id: order?.user_id || null,
        type: 'initial',
        status: 'succeeded',
        amount: order?.amount || null,
        currency: order?.currency || 'TWD',
        gateway: 'newebpay',
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
    return res.status(200).send('IGNORED'); // 避免重送風暴
  }
});

/* ===== 每日對帳：過期或取消就移除白名單 ===== */
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

/* ===== 健康檢查 ===== */
app.get('/api/health', (req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

app.listen(PORT, () => console.log(`Server on :${PORT}`));
