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