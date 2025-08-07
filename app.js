require('dotenv').config();
const supabase = require('./db');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 通用進站 log ==========
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl} - ${new Date().toISOString()}`);
  next();
});

// 允許主站跨域
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com'
  ]
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const path = require('path');
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  console.log(`[INFO] / 被訪問`);
  res.send('API is working!');
});

// 前端訂閱頁
app.get('/subscribe', (req, res) => {
  console.log(`[INFO] /subscribe 被訪問`);
  res.sendFile(path.join(__dirname, 'subscribe.html'));
});

// ========== 純註冊 API ==========
app.post('/api/register', async (req, res) => {
  console.log(`[API] /api/register`, req.body);
  try {
    const { userId, displayName, email, phone } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (user) {
      console.log(`[REGISTER] 用戶已註冊: ${userId}`);
      return res.json({ message: '已註冊' });
    }

    const now = new Date();

    const { data, error: insertError } = await supabase
      .from('users')
      .insert([{
        id: userId,
        display_name: displayName,
        email,
        phone,
        created_at: now.toISOString(),
      }])
      .select();

    if (insertError) throw insertError;
    console.log(`[REGISTER] 註冊成功: ${userId}`);
    res.json({ message: '註冊成功' });
  } catch (e) {
    console.error(`[REGISTER] Error:`, e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

// ========== 純訂閱（不帶推薦碼） ==========
app.post('/api/subscribe', async (req, res) => {
  console.log(`[API] /api/subscribe`, req.body);
  try {
    const { userId, displayName, email, plan, period } = req.body;
    const { data: selfUser, error: selfErr } = await supabase
      .from('users').select('*').eq('id', userId).single();
    if (!selfUser) {
      console.warn(`[SUBSCRIBE] 用戶不存在: ${userId}`);
      return res.status(400).json({ error: '用戶不存在' });
    }

    const order_no = `LMAI${Date.now()}${Math.floor(Math.random()*1000)}`;
    await supabase.from('orders').insert([{
      order_no,
      user_id: userId,
      period,
      status: 'pending',
      created_at: new Date().toISOString()
    }]);

    console.log(`[SUBSCRIBE] 訂單建立: ${order_no} 用戶: ${userId} 方案: ${plan} 周期: ${period}`);
    res.json({ message: '訂單已建立', order_no });
  } catch (err) {
    console.error('[SUBSCRIBE] API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 產生付款表單 ==========
app.get('/pay', async (req, res) => {
  try {
    const { order_no } = req.query;
    if (!order_no) return res.status(400).send('缺少訂單編號');

    // 查訂單
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_no', order_no)
      .single();
    if (!order) return res.status(404).send('查無訂單');

    // 判斷方案與金額
    let Amt = 199, PeriodType = 'M', PeriodTimes = 12, PeriodPoint = '01', Desc = 'LeiMai Pro 進階訂閱（月繳）';
    if (order.period === 'year') {
      Amt = 1999;
      PeriodType = 'Y';
      PeriodTimes = 1;
      PeriodPoint = (new Date().getMonth() + 1).toString().padStart(2, '0') + (new Date().getDate()).toString().padStart(2, '0'); // 當天
      Desc = 'LeiMai Pro 進階訂閱（年繳）';
    }
    // 補：email 若訂單無，給 test
    const Email = order.email || "test@example.com";
    const TimeStamp = `${Math.floor(Date.now() / 1000)}`;
    // 週期付款參數
    const periodInfoObj = {
      RespondType: 'JSON',
      TimeStamp,
      Version: '1.5',               // 定期定額API規定
      LangType: 'zh-Tw',
      MerOrderNo: order_no,         // 商店自訂編號
      ProdDesc: Desc,
      PeriodAmt: Amt,
      PeriodType: PeriodType,       // 'M'月繳，'Y'年繳
      PeriodPoint: PeriodPoint,     // 月繳每月1號，年繳填MMDD
      PeriodStartType: '2',         // 建議2(立即首期)
      PeriodTimes: PeriodTimes,     // 幾期
      PayerEmail: Email,
      EmailModify: 1,               // 付款頁email可修改
      NotifyURL: 'https://leimaitech-site.onrender.com/api/period-webhook', // 每期通知
      ReturnURL: 'https://leimaitech.com/payment-result.html?order_no=' + order_no
    };

    // AES 加密（與你原有金流相同）
    function aesEncrypt(data, key, iv) {
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let enc = cipher.update(qs.stringify(data), 'utf8', 'hex');
      enc += cipher.final('hex');
      return enc;
    }
    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;
    const postDataEnc = aesEncrypt(periodInfoObj, key, iv);

    // log for debug
    console.log('[PERIOD PAY] Params:', periodInfoObj);
    console.log('[PERIOD PAY] PostData_:', postDataEnc);

    // 產生定期定額表單（action & 欄位全換！）
    res.send(`
      <form id="periodPayForm" method="POST" action="https://ccore.newebpay.com/MPG/period">
        <input type="hidden" name="MerchantID_" value="${process.env.MERCHANT_ID}">
        <input type="hidden" name="PostData_" value="${postDataEnc}">
      </form>
      <script>document.getElementById('periodPayForm').submit();</script>
    `);
  } catch (err) {
    console.error('[PERIOD PAY] error:', err);
    res.status(500).send('Server error');
  }
});

// ========== 查詢訂單狀態 ==========
app.get('/api/order-status', async (req, res) => {
  const { order_no } = req.query;
  console.log(`[API] /api/order-status`, req.query);
  if (!order_no) return res.status(400).json({ status: 'missing_order_no' });

  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('order_no', order_no)
    .single();

  if (!order) {
    console.warn(`[ORDER-STATUS] 查無訂單: ${order_no}`);
    return res.status(404).json({ status: 'not_found' });
  }
  console.log(`[ORDER-STATUS] ${order_no} 狀態: ${order.status}`);
  res.json({ status: order.status });
});

// ========== NewebPay 金流 Webhook ==========
app.post('/api/webhook', async (req, res) => {
  console.log(`[API] /api/webhook`, req.body);
  try {
    const { TradeInfo, TradeSha } = req.body;
    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;
    const sha256 = (str, key, iv) => {
      const toHash = `HashKey=${key}&${str}&HashIV=${iv}`;
      return crypto.createHash('sha256').update(toHash).digest('hex').toUpperCase();
    };
    if (sha256(TradeInfo, key, iv) !== TradeSha) {
      console.warn(`[WEBHOOK] TradeSha 驗證失敗`);
      return res.status(400).send('驗證失敗');
    }
    function decryptTradeInfo(tradeInfo, key, iv) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(true);
      let decoded = decipher.update(tradeInfo, 'hex', 'utf8');
      decoded += decipher.final('utf8');
      return qs.parse(decoded);
    }
    const result = decryptTradeInfo(TradeInfo, key, iv);
    console.log(`[WEBHOOK] TradeInfo 解密結果:`, result);

    // 1. 查訂單
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('order_no', result.MerchantOrderNo)
      .single();

    if (!order) {
      console.warn(`[WEBHOOK] 查無訂單: ${result.MerchantOrderNo}`);
      return res.status(400).send('查無訂單');
    }

    // 2. 訂單狀態設為 paid
    await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('order_no', result.MerchantOrderNo);

    console.log(`[WEBHOOK] 完成訂單設為已付款: ${result.MerchantOrderNo}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[WEBHOOK] error:', err);
    res.status(500).send('Server Error');
  }
});

app.post('/api/period-webhook', async (req, res) => {
  try {
    // 藍新會用 application/x-www-form-urlencoded 傳送
    const Period = req.body.Period || req.body.period;
    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;
    // AES 解密
    function decryptPeriodInfo(period, key, iv) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(true);
      let decoded = decipher.update(period, 'hex', 'utf8');
      decoded += decipher.final('utf8');
      return JSON.parse(decoded);
    }
    const result = decryptPeriodInfo(Period, key, iv);
    console.log('[PERIOD WEBHOOK] Notify:', result);

    // 你可根據 result.Status / MerchantOrderNo / 授權成功失敗邏輯進行訂單與用戶狀態管理

    res.status(200).send('OK');
  } catch (err) {
    console.error('[PERIOD WEBHOOK] error:', err);
    res.status(500).send('Server Error');
  }
});

// ========== 啟動伺服器 ==========
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
