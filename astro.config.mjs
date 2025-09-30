import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// If you later reuse this repo for a user root site, set BASE to "/"
const base = process.env.BASE || '/Flow-Chart/'; // <- match your repo name with trailing slash

export default defineConfig({
    integrations: [react()],
    base,
    // optional but nice for canonical URLs:
    site: 'https://e8lau.github.io',
});
