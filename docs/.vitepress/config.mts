import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'AsyncUp',
  description: 'Open-source, self-hosted async daily standups for Google Chat',
  base: process.env.DOCS_BASE || '/',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.DOCS_BASE || '/'}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#15435f' }],
    ['meta', { property: 'og:title', content: 'AsyncUp — async daily standups for Google Chat' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Open source and self-hosted: standup prompts, date threads, blocker tracking, AI summaries with your own key.',
      },
    ],
  ],
  themeConfig: {
    logo: '/logo.svg',
    search: {
      provider: 'local',
    },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/asyncup-dev/asyncup' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Setup guide (all scenarios)', link: '/guide/server-setup' },
          { text: 'Google Chat setup', link: '/guide/google-chat-setup' },
          { text: 'Installing for your team', link: '/guide/distribution' },
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
