/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0f1e',
        panel: '#121a2d',
        accentRed: '#f43f5e',
        accentGreen: '#22c55e',
      },
    },
  },
  plugins: [],
}
