import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'AsyncUp',
  description: 'Open-source, self-hosted async daily standups for Google Chat',
  base: process.env.DOCS_BASE || '/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/asyncup-dev/asyncup' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Google Chat setup', link: '/guide/google-chat-setup' },
          { text: 'Commands', link: '/guide/commands' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'AI summaries', link: '/guide/ai' },
          { text: 'Web dashboard', link: '/guide/dashboard' },
          { text: 'Deployment', link: '/guide/deployment' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/asyncup-dev/asyncup' }],
    footer: {
      message: 'Released under the MIT License.',
    },
  },
});
