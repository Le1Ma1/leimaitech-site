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
  new Chart(ctx, {
    type: 'bar',
    data,
    options
  });
});