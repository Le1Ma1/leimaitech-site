```
LEIMAITECH-SITE/
├─ .venv/                         # 本機虛擬環境資料夾（若有使用，版控通常忽略）
├─ assets/                        # 共用靜態資源（圖片/圖示等）
│
├─ crypto-linebot/                # LINE Bot 訂閱漏斗頁（對台灣市場的行銷頁面）
│  ├─ assets/                     # 此子站專用資源
│  ├─ js/
│  │  └─ crypto.js               # 漏斗頁互動腳本（定價、滾動、CTA 綁定等）
│  ├─ index.html                  # 漏斗首頁（導向方案、CTA 按鈕）
│  ├─ privacy.html                # 隱私權頁（子站版）
│  ├─ returns.html                # 退款/退貨政策（子站版）
│  └─ terms.html                  # 使用條款（子站版）
│
├─ css/
│  └─ style.css                   # 主站樣式
│
├─ js/
│  └─ main.js                     # 主站共用腳本（導航/表單/追蹤）
│
├─ node_modules/                  # 依賴套件
├─ .env                           # 環境變數（本機/部署用，不應入版控）
├─ .gitignore                     # Git 忽略清單
│
├─ app.js                         # 伺服器進入點：Express 靜態檔服務、API、NewebPay Webhook
├─ db.js                          # 資料存取層（如連接 Supabase/Postgres；訂閱/交易記錄）
│
├─ index.html                     # 主站首頁（品牌、服務導流）
├─ subscribe.html                 # 訂閱方案頁（搭配藍新金流導購）
├─ payment-result.html            # 付款結果顯示頁（交易成功/失敗/等待）
├─ privacy.html                   # 主站隱私權頁
├─ terms.html                     # 主站使用條款
├─ returns.html                   # 主站退款/退貨政策（若存在）
│
├─ CNAME                          # 自訂網域設定（GitHub Pages/靜態託管使用時）
├─ package.json                   # 專案設定與腳本
├─ package-lock.json              # 依賴鎖定檔
└─ README.md                      # 本說明文件
```