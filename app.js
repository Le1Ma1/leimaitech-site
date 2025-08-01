const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');

// 建立 Express app
const app = express();
const PORT = process.env.PORT || 3000;

// 跨域設定（允許你的主站呼叫這個 API）
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com'
  ]
}));

// 處理 JSON 和表單資料
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 測試 API 路由
app.get('/', (req, res) => {
  res.send('API is working!');
});

const path = require('path');
app.use(express.static(path.join(__dirname))); // 讓靜態檔案可直接存取

app.get('/subscribe', (req, res) => {
  res.sendFile(path.join(__dirname, 'subscribe.html'));
});

// 金流訂閱 API
app.post('/api/subscribe', (req, res) => {
  res.json({ message: '訂閱API已收到', body: req.body });
});


// 金流 webhook
app.post('/api/webhook', (req, res) => {
  try {
    // Step 1: 取回 TradeInfo 與 TradeSha
    const { TradeInfo, TradeSha } = req.body;

    // Step 2: 驗證 TradeSha
    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;
    const sha256 = (str, key, iv) => {
      const toHash = `HashKey=${key}&${str}&HashIV=${iv}`;
      return crypto.createHash('sha256').update(toHash).digest('hex').toUpperCase();
    };
    if (sha256(TradeInfo, key, iv) !== TradeSha) {
      return res.status(400).send('驗證失敗');
    }

    // Step 3: 解密 TradeInfo（AES-256-CBC 解密）
    function decryptTradeInfo(tradeInfo, key, iv) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(true);
      let decoded = decipher.update(tradeInfo, 'hex', 'utf8');
      decoded += decipher.final('utf8');
      return qs.parse(decoded);
    }
    const result = decryptTradeInfo(TradeInfo, key, iv);

    // Step 4: 依據 result.PayAmt, result.Status, result.MerchantOrderNo, result.PeriodType, result.PayerEmail 等資料做會員開通
    // 這裡你可以：寫入 DB、加白名單、推播 LINE Message 給 userId

    // Step 5: 回應 200 OK 告知藍新你已收到
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
