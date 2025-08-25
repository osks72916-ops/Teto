import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pagesにデプロイするリポジトリ名に変更
export default defineConfig({
  plugins: [react()],
  base: '/my-vocal-app/' // ←GitHubリポジトリ名
})
