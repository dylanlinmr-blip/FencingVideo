import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: ['3000-i42psi2g0v0kqiownnxas-dfc00ec5.sandbox.novita.ai'],
  },
})
