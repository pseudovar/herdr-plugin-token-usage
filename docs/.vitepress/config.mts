import { defineConfig } from "vitepress";

const repo = "https://github.com/pseudovar/herdr-plugin-token-usage";
const site = "https://pseudovar.github.io/herdr-plugin-token-usage";
const description =
  "Live token usage, GitHub Copilot credits, cost and performance for every coding agent in herdr: Pi, OpenCode, Copilot CLI and Claude Code.";

export default defineConfig({
  title: "Token Usage",
  titleTemplate: ":title · Token Usage for herdr",
  description,
  lang: "en",
  base: "/herdr-plugin-token-usage/",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/herdr-plugin-token-usage/logo.svg" }],
    ["meta", { name: "theme-color", content: "#1e1e2e" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Token Usage for herdr" }],
    ["meta", { property: "og:title", content: "Token Usage: a herdr plugin" }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:image", content: `${site}/shots/social-preview.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  sitemap: { hostname: `${site}/` },
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/configuration", activeMatch: "/reference/" },
      { text: "Changelog", link: "/changelog" },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Install", link: "/guide/install" },
          { text: "Set up herdr", link: "/guide/setup" },
        ],
      },
      {
        text: "Using it",
        items: [
          { text: "Sidebar and tab bar", link: "/guide/sidebar-and-tab-bar" },
          { text: "Dashboard", link: "/guide/dashboard" },
          { text: "Charts", link: "/guide/charts" },
          { text: "Alerts and rules", link: "/guide/alerts" },
        ],
      },
      {
        text: "Background",
        items: [
          { text: "Harnesses and accuracy", link: "/guide/harnesses" },
          { text: "How it works", link: "/guide/how-it-works" },
          { text: "Privacy", link: "/guide/privacy" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Sidebar tokens", link: "/reference/tokens" },
          { text: "CLI", link: "/reference/cli" },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Changelog", link: "/changelog" },
          { text: "Contributing", link: "/contributing" },
          { text: "Design notes", link: "/DESIGN" },
          { text: "Research notes", link: "/RESEARCH" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: 'Released under the <a href="https://github.com/pseudovar/herdr-plugin-token-usage/blob/main/LICENSE">MIT License</a>. Not affiliated with herdr, GitHub or Anthropic.',
      copyright: "© 2026 Jason Ford",
    },
  },
});
