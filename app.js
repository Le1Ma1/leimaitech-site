// app.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

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
  // 這裡放你處理 NewebPay 回調資料的邏輯
  // 記錄用戶付款狀態、自動啟用白名單
  res.json({ message: 'Webhook已收到', body: req.body });
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
