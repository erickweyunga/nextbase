import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes } from "prism-react-renderer";

const REPOSITORY = "https://github.com/erickweyunga/nextbase";

const config: Config = {
  title: "NextBase",
  tagline:
    "Your backend, built into Next.js: database, auth and auto-generated APIs.",
  favicon: "nextbase-icon-dark.svg",
  url: "https://nextbase.dev",
  baseUrl: "/",
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  future: {
    v4: {
      removeLegacyPostBuildHeadAttribute: true,
      // Experimental: its polyfill outranks every rule in custom.css.
      useCssCascadeLayers: false,
      siteStorageNamespacing: true,
      fasterByDefault: true,
      mdx1CompatDisabledByDefault: true,
    },
  },
  // The brand assets live in one place, at the repository root.
  staticDirectories: ["static", "../../brand/svg"],
  i18n: { defaultLocale: "en", locales: ["en"] },
  clientModules: ["./src/fonts.ts"],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          breadcrumbs: false,
          editUrl: `${REPOSITORY}/tree/main/apps/docs/`,
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      { hashed: true, indexBlog: false, docsRouteBasePath: "/docs" },
    ],
  ],

  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: "",
      logo: {
        alt: "NextBase",
        src: "nextbase-logo-dark.svg",
        srcDark: "nextbase-logo-light.svg",
        height: 24,
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          label: "Docs",
          position: "left",
        },
        { to: "/docs/api", label: "REST API", position: "left" },
        {
          href: REPOSITORY,
          position: "right",
          className: "header-github-link",
          "aria-label": "GitHub repository",
        },
      ],
    },
    footer: {
      style: "dark",
      copyright: `MIT ${new Date().getFullYear()} © NextBase`,
    },
    prism: {
      theme: themes.github,
      darkTheme: themes.dracula,
      additionalLanguages: ["bash", "json", "http"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
