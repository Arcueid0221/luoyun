import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiPlugin } from './server/plugin.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugin()],
  server: {
    // 只监听回环地址，绝不要加 --host。
    // 这个 dev server 能用你的网易云账号做任何事，还能读你的家目录 ——
    // 暴露到局域网等于把账号交出去。注意 CLI 的 --host 会覆盖这里。
    host: '127.0.0.1',
    port: 5678,
    strictPort: true,
    // Vite 默认给**所有** localhost 来源发 CORS 头，于是本机任何一个别的
    // dev server / Storybook / http://x.localhost 上的页面都能读我们的接口响应
    // （`GET /api/fs/list` 能一层层列出整个家目录）。页面和 API 同源，
    // 我们一个 CORS 头都不需要，直接关掉。
    cors: false,
  },
});
