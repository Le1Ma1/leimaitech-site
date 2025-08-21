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

// ==== 環境與常數 ====
const RESOLVE_ENV = () => {
  // 以 NEWEBPAY_BASE 為主，未設則預設 core（避免誤用測試站）
  const base = process.env.NEWEBPAY_BASE || 'https://core.newebpay.com';
  const mode = /ccore/.test(base) ? 'test' : 'prod';
  return { base, mode };
};
const { base: NEWEBPAY_BASE, mode: ENV_MODE } = RESOLVE_ENV();
const PERIOD_ENDPOINT = `${NEWEBPAY_BASE}/MPG/period`;

const MAIN_KEY = process.env.HASH_KEY || '';
const MAIN_IV  = process.env.HASH_IV || '';

const BOT_TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS || 4000);
const GRACE_DAYS = Number(process.env.GRACE_DAYS || 3);

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

console.log(`[BOOT] NEWEBPAY_BASE=${NEWEBPAY_BASE} (mode=${ENV_MODE})`);
console.log(`[BOOT] Merchant=${process.env.MERCHANT_ID || '(unset)'} | HASH_KEY set? ${!!MAIN_KEY} | TEST_HASH_KEY set? ${!!TEST_KEY}`);

app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com',
    'https://leimaitech-site.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]
}));

// 只啟用 JSON（供 /api/* 使用）；避免全域 urlencoded，免得 webhook 解析衝突
app.use(bodyParser.json({ limit: '1mb' }));

// 靜態檔 + .html fallback（專案根目錄）
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ===== 小工具 =====
function addDays(d, days){ const x=new Date(d.getTime()); x.setDate(x.getDate()+days); return x; }
function yyyymmdd(date){ const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,'0'), d=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; }

const isLineUserId = s => typeof s === 'string' && /^U[a-f0-9]{32}$/i.test(s);
const sha256U = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();

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
    signal: AbortSignal.timeout(BOT_TIMEOUT_MS)
  });
  return res.ok;
}

// 解析 multipart/form-data（只處理純文字欄位，精準去尾端 CRLF）
function parseMultipart(rawText, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) return {};
  const boundary = `--${m[1]}`;
  const chunks = rawText.split(boundary);
  const out = {};
  for (const chunk of chunks) {
    // 每段格式大致為 \r\nHeader...\r\n\r\nVALUE\r\n
    if (!/Content-Disposition/i.test(chunk)) continue;
    const nameMatch = /name="([^"]+)"/i.exec(chunk);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const idx = chunk.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const body = chunk.slice(idx + 4);
    const endIdx = body.lastIndexOf('\r\n');
    const val = (endIdx >= 0 ? body.slice(0, endIdx) : body);
    out[name] = val;
  }
  return out;
}

// AES 解密：同時嘗試 (hex/base64) × (key/iv: utf8/hex)
function aesTryAll(enc, key, iv) {
  const formats = ['hex', 'base64'];
  const keyFormats = ['utf8', 'hex'];

  const encLooksHex = /^[0-9a-fA-F]+$/.test(enc) && enc.length % 2 === 0;

  for (const encFmt of (encLooksHex ? ['hex','base64'] : ['base64','hex'])) {
    for (const kFmt of keyFormats) {
      for (const iFmt of keyFormats) {
        try {
          const kBuf = Buffer.from(key, kFmt);
          const iBuf = Buffer.from(iv,  iFmt);
          if (kBuf.length !== 32 || iBuf.length !== 16) continue; // 長度不對直接略過
          const decipher = crypto.createDecipheriv('aes-256-cbc', kBuf, iBuf);
          decipher.setAutoPadding(true);
          let out = decipher.update(enc, encFmt, 'utf8');
          out += decipher.final('utf8');
          return { ok:true, text: out, encFmt, kFmt, iFmt };
        } catch {}
      }
    }
  }
  return { ok:false };
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

// ===== 產生定期定額表單 =====
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

    const key = MAIN_KEY, iv = MAIN_IV;
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key,'utf8'), Buffer.from(iv,'utf8'));
    let postDataEnc = cipher.update(qs.stringify(periodInfoObj), 'utf8', 'hex'); postDataEnc += cipher.final('hex');

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

// ===== 定期定額 Webhook（同時支援 x-www-form-urlencoded / multipart/form-data）=====
app.post(
  '/api/period-webhook',
  express.text({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
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

      const keys = Object.keys(payload);
      console.log('[WEBHOOK] ct=', ct, 'rawLen=', rawText.length, 'keys=', keys);

      const enc = payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '';
      if (!enc) {
        console.warn('[WEBHOOK] 缺 enc');
        return res.status(200).send('IGNORED');
      }

      // 去重：用 enc 做 hash
      const eventHash = crypto.createHash('sha256').update(enc).digest('hex');
      await supabase.from('webhook_events').upsert([{
        event_source: 'newebpay_period',
        event_hash: eventHash,
        signature: payload.TradeSha || payload.TradeSHA || null,
        processed: false
      }], { onConflict: 'event_hash' });

      // 嘗試用主組解
      let usedEnv = 'prod';
      let d = aesTryAll(enc, MAIN_KEY, MAIN_IV);

      // 主組失敗，再嘗試測試組（若有提供）
      if (!d.ok && TEST_KEY && TEST_IV) {
        const dTest = aesTryAll(enc, TEST_KEY, TEST_IV);
        if (dTest.ok) {
          usedEnv = 'test';
          d = dTest;
          console.warn('[WEBHOOK] 解密使用 TEST_HASH_KEY/TEST_HASH_IV 成功，請檢查 NEWEBPAY_BASE 與金鑰組是否一致（你可能把請款送到 ccore，但伺服器用的是正式金鑰，或反之）。');
        }
      }

      if (!d.ok) {
        console.warn('[WEBHOOK] decrypt failed');
        await supabase.from('webhook_events')
          .update({
            payload: {
              decrypt_env: 'fail',
              enc_is_hex: /^[0-9a-fA-F]+$/.test(enc),
              enc_len: enc.length,
              sample: enc.slice(0, 64)
            }
          })
          .eq('event_hash', eventHash);
        return res.status(200).send('IGNORED');
      }

      const decodedText = d.text;
      let result; try { result = JSON.parse(decodedText); } catch { result = qs.parse(decodedText); }
      console.log('[WEBHOOK] decoded by', { usedEnv, encFmt: d.encFmt, kFmt: d.kFmt, iFmt: d.iFmt }, '=>', result);

      // 簽章驗證（有才驗），使用成功解密所用之 key/iv
      const providedSha = payload.TradeSha || payload.TradeSHA || '';
      if (providedSha) {
        const keyToUse = usedEnv === 'test' ? TEST_KEY : MAIN_KEY;
        const ivToUse  = usedEnv === 'test' ? TEST_IV  : MAIN_IV;
        const candidates = [
          `HashKey=${keyToUse}&${enc}&HashIV=${ivToUse}`,
          `HashKey=${keyToUse}&PostData_=${enc}&HashIV=${ivToUse}`,
          `HashKey=${keyToUse}&TradeInfo=${enc}&HashIV=${ivToUse}`,
          `HashKey=${keyToUse}&Period=${enc}&HashIV=${ivToUse}`
        ];
        const pass = candidates.some(s => sha256U(s) === providedSha);
        if (!pass) {
          console.warn('[WEBHOOK] SHA mismatch (env used:', usedEnv, ')');
          // 不中斷流程，但標記
        }
      }

      await supabase.from('webhook_events')
        .update({ payload: { ...result, decrypt_env: usedEnv } })
        .eq('event_hash', eventHash);

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
  }
);

// ===== 測試用：強制把訂單設為已付款（只在非 production 且設定了 FORCE_TOKEN 時啟用）=====
const ENABLE_FORCE = process.env.NODE_ENV !== 'production' && !!process.env.FORCE_TOKEN;
if (ENABLE_FORCE) {
  app.all('/api/_force-pay', express.json(), async (req, res) => {
    try {
      const token = (req.query.token || req.headers['x-force-token'] || '').toString();
      if (token !== process.env.FORCE_TOKEN) return res.sendStatus(403);

      const q = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };
      const orderNo = (q.order_no || q.orderNo || '').toString().trim();
      const newStatus = (q.status || 'paid').toString().toLowerCase(); // 'paid' | 'failed'
      const periodNo = q.period_no || q.periodNo || null;

      if (!orderNo) return res.status(400).json({ error: 'missing order_no' });
      const { data: order } = await supabase.from('orders').select('*').eq('order_no', orderNo).maybeSingle();
      if (!order) return res.status(404).json({ error: 'order_not_found' });

      const nowIso = new Date().toISOString();
      await supabase.from('orders')
        .update({
          status: newStatus === 'paid' ? 'paid' : 'failed',
          paid_at: newStatus === 'paid' ? nowIso : null,
          newebpay_period_no: periodNo || order.newebpay_period_no || null
        })
        .eq('order_no', orderNo);

      if (newStatus === 'paid') {
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
          gateway_period_no: periodNo || null,
          updated_at: nowIso,
        };
        const { data: existing } = await supabase
          .from('subscriptions')
          .select('id,status')
          .eq('user_id', order.user_id)
          .eq('plan', subPayload.plan)
          .in('status', ['trialing', 'active', 'past_due'])
          .maybeSingle();

        if (existing?.id) await supabase.from('subscriptions').update(subPayload).eq('id', existing.id);
        else await supabase.from('subscriptions').insert([subPayload]);

        await supabase.from('transactions').insert([{
          order_no: orderNo,
          user_id: order.user_id,
          type: 'initial',
          status: 'succeeded',
          amount: order.amount,
          currency: order.currency,
          gateway_trade_no: periodNo || 'force_test',
          paid_at: nowIso,
          raw_payload: { force: true }
        }]);

        try {
          await callBot(process.env.BOT_UPSERT_URL, {
            provider: 'line',
            user_id: order.user_id,
            plan: subPayload.plan,
            order_no: orderNo,
            period_no: periodNo || null,
            access_until: order.trial_end
          }, `force-${orderNo}`);
        } catch {}
      } else {
        await supabase.from('transactions').insert([{
          order_no: orderNo, user_id: order.user_id, type: 'initial', status:'failed',
          amount: order.amount, currency: order.currency, raw_payload: { force: true }
        }]);
      }

      return res.json({ ok: true, order_no: orderNo, status: newStatus });
    } catch (e) {
      console.error('[_force-pay] error', e);
      return res.status(500).json({ error: 'server_error' });
    }
  });
  console.log('[FORCE PAY] enabled');
} else {
  console.log('[FORCE PAY] disabled');
}

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

// 健康檢查
app.get('/api/health', (req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

app.listen(PORT, () => console.log(`Server on :${PORT}`));
