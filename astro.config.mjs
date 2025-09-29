import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
const base = process.env.BASE || '/';
export default defineConfig({ integrations: [react()], base });
