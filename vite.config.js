import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: "/StakeholderMap/" // This is important for GitHub Pages deployment
})