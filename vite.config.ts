import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: { watch: { ignored: ['**/.local/**', '**/.backups/**', '**/.cache/**', '**/dist-ai/**'] } },
  build: {
    rollupOptions: {
      input: { app: path.resolve(__dirname, 'index.html') },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
