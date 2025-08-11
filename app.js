// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const qs = require('qs');
const crypto = require('crypto');
const path = require('path');

const supabase = require('./db'); // Supabase client

const app = express();
const PORT = process.env.PORT || 3000;

// 環境切換（測試站 ccore、正式站 core）
const NEWEBPAY_BASE = process.env.NEWEBPAY_BASE || 'https://ccore.newebpay.com';
const PERIOD_ENDPOINT = `${NEWEBPAY_BASE}/MPG/period`;

// ===== 結構化日誌 + Request ID =====
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
    } catch(e){}
  });
  next();
});

app.use(cors({
  origin: ['https://leimaitech.com','https://www.leimaitech.com','http://localhost:3000','http://127.0.0.1:3000']
}));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '1mb' }));

// 靜態檔 + .html fallback
app.use(express.static(path.join(__dirname), {
  extensions: ['html']   // /subscribe -> /subscribe.html, /payment-result -> /payment-result.html
}));

// 顯式對應頁面
const send = (p) => (req, res) => res.sendFile(path.join(__dirname, p));
app.get(['/subscribe', '/subscribe/'], send('subscribe.html'));
app.get(['/payment-result', '/payment-result/'], send('payment-result.html'));
app.get(['/crypto-linebot', '/crypto-linebot/'], send('crypto-linebot/index.html'));

app.get('/healthz', (_,res)=>res.json({ok:true, env:process.env.NODE_ENV||'dev'}));
app.get('/readyz',  (_,res)=>res.json({ready:true}));

// ===== 小工具 =====
function addDays(d, days){ const x=new Date(d.getTime()); x.setDate(x.getDate()+days); return x; }
function yyyymmdd(date){ const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,'0'), d=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; }
function aesEncrypt(obj, key, iv){
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key,'utf8'), Buffer.from(iv,'utf8'));
  let enc = cipher.update(qs.stringify(obj), 'utf8', 'hex'); enc += cipher.final('hex'); return enc;
}
function aesDecryptHexToText(hex, key, iv){
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key,'utf8'), Buffer.from(iv,'utf8'));
  decipher.setAutoPadding(true);
  let out = decipher.update(hex, 'hex', 'utf8'); out += decipher.final('utf8'); return out;
}
const isLineUserId = (s) => typeof s === 'string' && /^U[a-f0-9]{32}$/i.test(s);
const sha256U = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();

// ===== 使用者註冊（必須是 LINE userId）=====
app.post('/api/register', async (req, res) => {
  try{
    const { userId, displayName, email, phone } = req.body || {};
    if (!isLineUserId(userId)) {
      console.warn('[REGISTER] 非 LINE userId 拒絕:', userId);
      return res.status(400).json({ error: '請用 LINE 開啟並取得 LINE userId 後再註冊' });
    }
    const { data: existed } = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (!existed) {
      await supabase.from('users').insert([{ id: userId, display_name: displayName || null, email: email || null, phone: phone || null }]);
      console.log(`[REGISTER] 新增用戶: ${userId}`);
    } else {
      console.log(`[REGISTER] 已存在: ${userId}`);
    }
    res.json({ ok: true, userId });
  }catch(e){
    console.error('[REGISTER] error', e); res.status(500).json({ error: 'Server error' });
  }
});

// ===== 建單（僅允許 LINE userId）=====
app.post('/api/subscribe', async (req, res) => {
  try{
    const { userId, plan='pro', period='month', email } = req.body || {};
    if (!isLineUserId(userId)) {
      console.warn('[SUBSCRIBE] 非 LINE userId 拒絕:', userId);
      return res.status(400).json({ error: '缺少有效的 LINE userId' });
    }
    // 用戶存在檢查
    const { data: user } = await supabase.from('users').select('id').eq('id', userId).single();
    if (!user) return res.status(400).json({ error: '用戶未註冊' });

    // 方案金額
    const Amt = period === 'year' ? 1999 : 199;
    const now = new Date();
    const trialDays = 10;
    const trialEnd = addDays(now, trialDays);
    const firstChargeDate = trialEnd;

    let PeriodType = (period==='year') ? 'Y' : 'M';
    let PeriodPoint;
    if (PeriodType === 'M') {
      PeriodPoint = String(firstChargeDate.getDate()).padStart(2, '0'); // 月繳：日
    } else {
      const mm = String(firstChargeDate.getMonth()+1).padStart(2,'0');
      const dd = String(firstChargeDate.getDate()).padStart(2,'0');
      PeriodPoint = `${mm}${dd}`; // 年繳：MMDD
    }

    const order_no = `LMAI${Date.now()}${Math.floor(Math.random()*1000)}`;
    await supabase.from('orders').insert([{
      order_no,
      user_id: userId,
      plan,
      period,
      status: 'pending',
      amount: Amt,
      currency: 'TWD',
      email: email || null,
      trial_days: trialDays,
      trial_start: now.toISOString(),
      trial_end: trialEnd.toISOString(),
      first_charge_date: yyyymmdd(firstChargeDate),
      period_type: PeriodType,
      period_point: PeriodPoint,
      created_at: now.toISOString(),
    }]);

    console.log(`[SUBSCRIBE] 建單: ${order_no} LINE:${userId} Amt:${Amt} 首扣:${yyyymmdd(firstChargeDate)} PType:${PeriodType} PPoint:${PeriodPoint}`);
    res.json({ message: '訂單已建立', order_no });
  }catch(e){
    console.error('[SUBSCRIBE] error', e); res.status(500).json({ error: 'Server error' });
  }
});

// ===== 產生定期定額表單（NDNP 委託建立）=====
app.get('/pay', async (req, res) => {
  try{
    const { order_no } = req.query;
    if (!order_no) return res.status(400).send('缺少訂單編號');

    const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).single();
    if (!order) return res.status(404).send('找不到訂單');

    // 僅允許 LINE userId 的訂單
    if (!isLineUserId(order.user_id)) return res.status(400).send('缺少有效的 LINE userId');

    const TimeStamp = Math.floor(Date.now()/1000).toString();
    const periodInfoObj = {
      RespondType: 'JSON',
      TimeStamp,
      Version: '1.5',
      LangType: 'zh-Tw',
      MerOrderNo: order_no,                         // 有些版本用 MerchantOrderNo
      ProdDesc: 'Leimaitech Pro Subscription',
      PeriodAmt: order.amount,
      PeriodType: order.period_type,                // 'M' or 'Y'
      PeriodPoint: order.period_point,              // 'DD' or 'MMDD'
      PeriodStartType: '1',                         // 延後首扣（試用後）
      PeriodTimes: 999,
      PayerEmail: order.email || 'test@example.com',
      EmailModify: 1,
      NotifyURL: process.env.PERIOD_NOTIFY_URL,
      ReturnURL: `${process.env.RETURN_URL_BASE || 'https://leimaitech.com'}/payment-result.html?order_no=${order_no}`
    };

    const key = process.env.HASH_KEY, iv = process.env.HASH_IV;
    const postDataEnc = aesEncrypt(periodInfoObj, key, iv);

    console.log('[PERIOD PAY] Params:', periodInfoObj);
    res.send(`
      <form id="periodPayForm" method="POST" action="${PERIOD_ENDPOINT}">
        <input type="hidden" name="MerchantID_" value="${process.env.MERCHANT_ID}">
        <input type="hidden" name="PostData_" value="${postDataEnc}">
      </form>
      <script>document.getElementById('periodPayForm').submit();</script>
    `);
  }catch(e){
    console.error('[PERIOD PAY] error', e); res.status(500).send('Server error');
  }
});

// ===== 訂單狀態查詢（結果頁輪詢）=====
app.get('/api/order-status', async (req, res) => {
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ error: 'missing order_no' });
  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).single();
  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status, order });
});

// ===== 定期定額 Webhook（NDNP 驗簽 + 解密 + 冪等）=====
app.post('/api/period-webhook', bodyParser.urlencoded({ extended: false, limit: '1mb' }), async (req, res) => {
  try{
    const payload = typeof req.body === 'string' ? qs.parse(req.body) : (req.body || {});
    console.log('[WEBHOOK] raw:', payload);

    // 取加密欄位
    const enc = payload.Period || payload.period || payload.PostData_ || payload.TradeInfo || '';
    if (!enc) { console.warn('[WEBHOOK] 缺 enc'); return res.status(400).send('Missing payload'); }

    // 事件雜湊（用於去重 / update）
    const eventHash = crypto.createHash('sha256').update(enc).digest('hex');

    // (可選) 先 upsert 一筆事件骨架，避免重送時重複插入
    await supabase
      .from('webhook_events')
      .upsert([{
        event_source: 'newebpay_period',
        event_hash: eventHash,
        signature: payload.TradeSha || payload.TradeSHA || null,
        processed: false
      }], { onConflict: 'event_hash' });

    // 驗簽（若提供）
    const key = process.env.HASH_KEY, iv = process.env.HASH_IV;
    const providedSha = payload.TradeSha || payload.TradeSHA || '';
    if (providedSha) {
      const candidates = [
        `HashKey=${key}&${enc}&HashIV=${iv}`,          // 無欄位名
        `HashKey=${key}&PostData_=${enc}&HashIV=${iv}`,// NDNP 常見
        `HashKey=${key}&TradeInfo=${enc}&HashIV=${iv}`,// NDNF/MPG
        `HashKey=${key}&Period=${enc}&HashIV=${iv}`    // 有些舊版
      ];
      const ok = candidates.some(str => sha256U(str) === providedSha);
      if (!ok) {
        console.warn('[WEBHOOK] SHA mismatch', { providedSha });
        return res.status(200).send('IGNORED'); // 不更新狀態
      }
    }

    // 解密 → 解析
    const decodedText = aesDecryptHexToText(enc, key, iv);
    let result; try { result = JSON.parse(decodedText); } catch { result = qs.parse(decodedText); }
    console.log('[WEBHOOK] decoded:', result);

    // 補上 payload（含原文）
    await supabase
      .from('webhook_events')
      .update({ payload: result })
      .eq('event_hash', eventHash);

    // 取訂單號
    const merOrderNo =
      result?.MerOrderNo ||
      result?.MerchantOrderNo ||
      result?.Result?.MerOrderNo ||
      result?.Result?.MerchantOrderNo;
    if (!merOrderNo) {
      console.warn('[WEBHOOK] 無 MerOrderNo / MerchantOrderNo');
      return res.status(200).send('IGNORED');
    }

    // 成功判斷
    const respondCode = result?.Result?.RespondCode || result?.RespondCode || result?.ReturnCode || result?.RtnCode;
    const status = (result?.Status || '').toString().toUpperCase();
    const isSuccess = status === 'SUCCESS' || respondCode === '00';

    // 週期識別
    const periodNo = result?.PeriodNo || result?.Result?.PeriodNo || result?.Result?.PeriodInfo || null;

    if (isSuccess) {
      await supabase.from('orders').update({ status: 'paid' }).eq('order_no', merOrderNo);
      const { data: order } = await supabase.from('orders').select('*').eq('order_no', merOrderNo).single();

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
          period_times: 999,
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
      }

      await supabase.from('transactions').insert([{
        order_no: merOrderNo,
        type: 'initial',
        status: 'success',
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

    // 標記 processed
    await supabase
      .from('webhook_events')
      .update({ processed: true })
      .eq('event_hash', eventHash);

    res.status(200).send('OK');
  }catch(e){
    console.error('[WEBHOOK] error', e); res.status(500).send('Server Error');
  }
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));
