/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // 新版 UI 的深空配色（纯追加，不影响旧界面已有的类名）
      colors: {
        space: {
          950: '#04060d', // 最深：星空底色
          900: '#0a0f1c', // 侧边栏底色
          850: '#101728', // 卡片 / 悬浮面板
          800: '#16203a', // 悬停 / 抬升面
          700: '#1e2a44', // 常规描边
          600: '#2b3a5c', // 强调描边
        },
      },
    },
  },
  plugins: [],
}
