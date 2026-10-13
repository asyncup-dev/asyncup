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
        content: 'Open source and self-hosted: standup prompts, date threads, blocker tracking, group rosters, insights, SSO.',
      },
    ],
  ],
  themeConfig: {
    logo: '/logo.svg',
    search: {
      provider: 'local',
    },
    nav: [
      { text: 'Get started', link: '/guide/getting-started' },
      { text: 'Reference', link: '/guide/commands' },
      { text: 'GitHub', link: 'https://github.com/asyncup-dev/asyncup' },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Handbook (index)', link: '/guide/handbook' },
        ],
      },
      {
        text: 'Set up',
        items: [
          { text: '1. Host', link: '/guide/server-setup' },
          { text: '2. Google Cloud and the Chat app', link: '/guide/google-chat-setup' },
          { text: '3. Guided setup and first test', link: '/guide/first-standup' },
          { text: '4. Roll out to your team', link: '/guide/distribution' },
          { text: '5. Directory and group rosters', link: '/guide/directory' },
          { text: '6. Sign-in: Google, SAML, SCIM', link: '/guide/enterprise-sso' },
          { text: '7. Operations', link: '/guide/operations' },
        ],
      },
      {
        text: 'Use',
        items: [
          { text: 'Web app', link: '/guide/web-app' },
          { text: 'Personal schedules', link: '/guide/schedules' },
          { text: 'User guide', link: '/guide/user-guide' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands', link: '/guide/commands' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Roles and permissions', link: '/guide/roles' },
          { text: 'JSON API', link: '/guide/api' },
          { text: 'Claude Code and MCP', link: '/guide/mcp' },
          { text: 'Deployment reference', link: '/guide/deployment' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/asyncup-dev/asyncup' }],
    footer: {
      message: 'Released under the MIT License.',
    },
  },
});
