// JavaScript for the crypto‑linebot page. This script initialises the
// stacked bar chart using Chart.js. It also ensures the canvas resizes
// responsively.

document.addEventListener('DOMContentLoaded', () => {
  const ctx = document.getElementById('holdingChart').getContext('2d');
  // Example data representing different categories of holdings. In a
  // production environment these values would be populated from live
  // aggregated data sources. Values are expressed in百萬顆單位 for示意.
  const data = {
    labels: ['持幣類別'],
    datasets: [
      {
        label: 'Lost Supply',
        data: [24],
        backgroundColor: '#5a5aff'
      },
      {
        label: 'Long Term Holder',
        data: [16],
        backgroundColor: '#7f5cff'
      },
      {
        label: 'Speculative',
        data: [11],
        backgroundColor: '#00c2ff'
      },
      {
        label: 'Miners',
        data: [8],
        backgroundColor: '#37e1ff'
      },
      {
        label: 'ETF',
        data: [13],
        backgroundColor: '#a380ff'
      },
      {
        label: 'Institutional',
        data: [19],
        backgroundColor: '#ff8bcf'
      },
      {
        label: 'Unmined Supply',
        data: [30],
        backgroundColor: '#ffc857'
      }
    ]
  };
  const options = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#f5f5fa',
          padding: 8,
          boxWidth: 12
        }
      },
      title: {
        display: false
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            const label = context.dataset.label;
            const value = context.parsed.x;
            // All numbers display with spaces before and after
            return `${label}  :  ${value}  百萬顆`;
          }
        }
      }
    },
    scales: {
      x: {
        stacked: true,
        ticks: {
          color: '#f5f5fa'
        },
        grid: {
          color: 'rgba(255,255,255,0.1)'
        },
        title: {
          display: true,
          text: '數量 (百萬顆)',
          color: '#00c2ff'
        }
      },
      y: {
        stacked: true,
        ticks: {
          color: '#f5f5fa'
        },
        grid: {
          display: false
        }
      }
    }
  };
  // Create chart instance and expose for updates
  let chartInstance = new Chart(ctx, {
    type: 'bar',
    data: JSON.parse(JSON.stringify(data)),
    options
  });

  // Predefined sample datasets for demonstration; values in百萬顆單位
  const sampleSets = [
    [24, 16, 11, 8, 13, 19, 30],
    [20, 18, 9, 6, 10, 24, 33],
    [28, 14, 12, 10, 15, 16, 27]
  ];
  let sampleIndex = 0;
  const refreshBtn = document.getElementById('refreshData');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      sampleIndex = (sampleIndex + 1) % sampleSets.length;
      const newData = sampleSets[sampleIndex];
      chartInstance.data.datasets.forEach((dataset, idx) => {
        dataset.data[0] = newData[idx];
      });
      chartInstance.update();
    });
  }

  // Scroll reveal for crypto page sections
  const revealElements = document.querySelectorAll('.reveal, .process-step');
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  revealElements.forEach(el => {
    observer.observe(el);
  });

  // Parallax effect on hero content
  const hero = document.querySelector('.hero-crypto');
  const content = document.querySelector('.hero-crypto .content');
  if (hero && content) {
    hero.addEventListener('mousemove', (e) => {
      const rect = hero.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      content.style.transform = `translate(${x * 20}px, ${y * 20}px)`;
    });
    hero.addEventListener('mouseleave', () => {
      content.style.transform = '';
    });
  }

  // Back to top button behaviour for crypto page
  const backToTop = document.getElementById('backToTop');
  const toggleBackToTop = () => {
    if (!backToTop) return;
    if (window.scrollY > window.innerHeight) {
      backToTop.classList.add('visible');
    } else {
      backToTop.classList.remove('visible');
    }
  };
  window.addEventListener('scroll', toggleBackToTop);
  if (backToTop) {
    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
});
// 動態標語
const promoTitles = [
  "懶人數據生活，全部 LINE 一次搞定！",
  "App 太多？網站太雜？一鍵進 LINE 就搞定！",
  "你的數據入口，從今天開始更聰明。",
  "用 LINE 玩轉加密數據，就是這麼簡單！"
];
let promoTitleIdx = 0;
setInterval(() => {
  const el = document.getElementById("promoTitle");
  if (el) {
    promoTitleIdx = (promoTitleIdx + 1) % promoTitles.length;
    el.innerText = promoTitles[promoTitleIdx];
  }
}, 4000);

// 互動小調查
function promoPollVote(btn, num) {
  const res = document.getElementById("promoPollResult");
  const btns = document.querySelectorAll(".promo-poll button");
  // 高亮本按鈕並 disable 全部
  btns.forEach(b => {
    b.disabled = true;
    b.classList.remove("selected");
  });
  btn.classList.add("selected");

  // 美觀互動 + 動畫效果 + 震動
  if (res) {
    res.innerHTML = `
      <span style="font-size:1.25em; color:#00e699; font-weight:700;">🎉 感謝你的參與！</span><br>
      👍 有 <b>${num}</b> 個以上的朋友，你不是孤單！<br>
      <span style="color:#8ad1ff;">用 LeiMai，直接 LINE 數據推播，輕鬆省下切換煩惱！</span>
    `;
    res.classList.add("visible");
    // 瀏覽器震動支援
    if (window.navigator && window.navigator.vibrate) {
      window.navigator.vibrate([60, 20, 60]);
    }
    setTimeout(() => {
      res.classList.remove("visible");
      btns.forEach(b => {
        b.disabled = false;
        b.classList.remove("selected");
      });
      res.innerHTML = "";
    }, 3200);
  }
}
