import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Allr',
  tagline: 'One workspace. Finished work.',
  favicon: 'img/favicon.ico',

  url: 'https://allr.work',
  baseUrl: '/docs/',

  organizationName: 'allr-ajmx',
  projectName: 'allr-agent',

  onBrokenLinks: 'throw',

  // Brand faces: Young Serif for headings, Nunito Sans for body. Loaded as a
  // plain stylesheet link so the theme stays unswizzled.
  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Young+Serif&family=Nunito+Sans:wght@300;400;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
      type: 'text/css',
    },
  ],

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-Hans'],
    localeConfigs: {
      en: {
        label: 'English',
      },
      'zh-Hans': {
        label: '简体中文',
        htmlLang: 'zh-Hans',
      },
    },
  },

  themes: [
    '@docusaurus/theme-mermaid',
    // Local (offline) search. Replaces Algolia DocSearch, which pointed at an
    // index this project does not own. Scoped to docs only and hashed so the
    // client index stays as small as the page count allows — the reason the
    // local plugin was dropped before was a ~16 MB whole-site index.
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: '/',
        language: ['en', 'zh'],
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Static-host redirects for renamed doc pages (GitHub Pages can't
        // do server-side redirects). Paths are relative to baseUrl (/docs/).
        redirects: [
          // Renamed off the pre-fork brand. The link TEXT was rebranded long ago but
          // the slugs were not, so these URLs are live and must keep resolving.
          {from: '/guides/use-mcp-with-hermes', to: '/guides/use-mcp-with-allr'},
          {from: '/guides/use-soul-with-hermes', to: '/guides/use-soul-with-allr'},
          {from: '/guides/use-voice-mode-with-hermes', to: '/guides/use-voice-mode-with-allr'},
          {from: '/guides/run-hermes-with-nous-portal', to: '/guides/run-allr-with-nous-portal'},
          {
            from: '/guides/secure-hermes-on-a-work-machine',
            to: '/guides/secure-allr-on-a-work-machine',
          },
          {
            // Removed: a time-boxed provider promotion (a free window that closed
            // in June). Allr documents capability, not partner offers.
            from: '/guides/run-nemotron-3-ultra-free',
            to: '/integrations/providers',
          },
          {
            // Renamed in #44470 (Automation Blueprints terminology rebrand)
            from: '/guides/automation-templates',
            to: '/guides/automation-blueprints',
          },
          {
            // Moved when the Plugins subcategory was created under
            // Developer Guide > Extending (docs restructure, July 2026)
            from: '/guides/build-a-hermes-plugin',
            to: '/developer-guide/plugins',
          },
          {
            // Users guess these short paths from abbreviated links and hit
            // raw 404s (consumer-onboarding audit finding #1, Aug 2026).
            from: '/quickstart',
            to: '/getting-started/quickstart',
          },
          {
            from: '/installation',
            to: '/getting-started/installation',
          },
        ],
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',  // Docs at the root of /docs/
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/allr-ajmx/allr-agent/edit/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/allr-agent-banner.png',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
    navbar: {
      title: 'Allr',
      logo: {
        alt: 'Allr',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/skills',
          label: 'Skills',
          position: 'left',
        },
        {
          href: 'https://allr.work/',
          label: 'Download',
          position: 'left',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
        {
          href: 'https://allr.work',
          label: 'Home',
          position: 'right',
        },
        {
          href: 'https://github.com/allr-ajmx/allr-agent',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/getting-started/quickstart' },
            { label: 'User Guide', to: '/user-guide/cli' },
            { label: 'Developer Guide', to: '/developer-guide/architecture' },
            { label: 'Reference', to: '/reference/cli-commands' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub Issues', href: 'https://github.com/allr-ajmx/allr-agent/issues' },
            { label: 'Skills Hub', href: 'https://agentskills.io' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'Download', href: 'https://allr.work/' },
            { label: 'GitHub', href: 'https://github.com/allr-ajmx/allr-agent' },
            { label: 'Upstream', href: 'https://github.com/NousResearch/hermes-agent' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Allr. Built on <a href="https://github.com/NousResearch/hermes-agent">NousResearch/hermes-agent</a> (MIT).`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json', 'python', 'toml'],
    },
    mermaid: {
      theme: {light: 'neutral', dark: 'dark'},
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
