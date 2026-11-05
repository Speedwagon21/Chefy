module.exports = {
  content: ['./public/index.html', './public/app.js'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eef6ff', 100: '#d9eaff', 200: '#bcdaff', 300: '#8ec3ff', 400: '#4aa6ff', 500: '#0992fe', 600: '#006be6', 700: '#0057c2', 800: '#00489f', 900: '#063c80', 950: '#06244d' }
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] }
    }
  }
};
