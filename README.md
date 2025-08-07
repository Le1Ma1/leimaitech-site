```
LEIMAITECH-SITE/
├── .venv/ # 虛擬環境資料夾（如有用 Python）
├── assets/ # 主站公用靜態素材（Logo, 背景圖等）
├── crypto-linebot/ # 加密貨幣機器人專用分頁
│ ├── assets/ # 加密貨幣頁素材（Logo、背景、icon 等）
│ ├── js/
│ │ └── crypto.js # Crypto 頁面專用的 JS（Chart.js 圖表、互動）
│ ├── index.html # 加密貨幣機器人主頁（功能、訂閱方案、導流）
│ ├── privacy.html # 隱私權條款
│ ├── returns.html # 退換貨政策
│ ├── terms.html # 會員服務條款
├── css/
│ └── style.css # 全站主樣式（含訂閱頁、首頁、品牌頁）
├── js/
│ └── main.js # 主站通用 JS（首頁特效、粒子動畫等）
├── node_modules/ # Node.js 依賴模組
├── .env # 環境變數設定（私密，勿外流）
├── .gitignore # Git 版本控管忽略規則
├── app.js # Node/Express 主要後端 API 服務
├── db.js # 資料庫（Supabase/Postgres）連線管理
├── CNAME # GitHub Pages 自訂網域設定檔
├── index.html # 主站首頁（品牌形象、入口）
├── package-lock.json # npm 套件鎖定檔
├── package.json # npm 專案描述與依賴管理
├── payment-result.html # 金流付款結果查詢頁
├── README.md # 專案說明文件
└── subscribe.html # 訂閱方案升級頁（LINE LIFF 授權/付款）
```