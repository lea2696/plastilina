import { defineConfig } from 'vite';
// Two pages: Masa at / (index.html) and the yoyó at /yoyo (yoyo.html; Vite serves /yoyo → yoyo.html in dev and preview,
// vercel.json rewrites it in production).
export default defineConfig({ worker: { format: 'iife' }, build: { rollupOptions: { input: { index: 'index.html', yoyo: 'yoyo.html' } } }, test: { environment: 'node', exclude: ['tests/e2e/**', 'node_modules/**'] } });
