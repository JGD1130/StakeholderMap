import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/StakeholderMap/', // <-- THIS IS THE CRITICAL LINE
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!/node_modules[\\/]/.test(id)) return
          if (id.includes('mapbox-gl')) return 'vendor-mapbox'
          if (id.includes('@turf')) return 'vendor-turf'
          if (id.includes('firebase')) return 'vendor-firebase'
          if (id.includes('jspdf')) return 'vendor-pdf'
          if (id.includes('openai')) return 'vendor-openai'
          if (id.includes('html2canvas')) return 'vendor-canvas'
          if (id.includes('svgson') || id.includes('svg-path-parser')) return 'vendor-svg'
          if (id.includes('react-dom') || /node_modules[\\/]react[\\/]/.test(id)) return 'vendor-react'
          return 'vendor-misc'
        }
      }
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true
      },
      '/ai': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai/, '')
      }
    }
  }
})
