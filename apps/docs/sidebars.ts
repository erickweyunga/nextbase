import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// Top-level groups, each with an icon (see `sidebar-icon-*` in custom.css).
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Get started",
      className: "sidebar-icon sidebar-icon-start",
      items: ["index", "getting-started"],
    },
    {
      type: "category",
      label: "Concepts",
      className: "sidebar-icon sidebar-icon-concepts",
      items: [
        "guides/collections",
        "guides/records",
        "guides/filters",
        "guides/rules",
      ],
    },
    {
      type: "category",
      label: "Authentication",
      className: "sidebar-icon sidebar-icon-auth",
      items: [
        { type: "doc", id: "guides/auth/index", label: "Overview" },
        "guides/auth/sessions",
      ],
    },
    {
      type: "category",
      label: "Next.js",
      className: "sidebar-icon sidebar-icon-nextjs",
      items: ["guides/server"],
    },
    {
      type: "category",
      label: "Production",
      className: "sidebar-icon sidebar-icon-production",
      items: ["guides/production"],
    },
    {
      type: "category",
      label: "Reference",
      className: "sidebar-icon sidebar-icon-reference",
      items: [
        { type: "doc", id: "api/index", label: "REST API" },
        { type: "doc", id: "api/records", label: "Records" },
        { type: "doc", id: "api/auth", label: "Auth" },
        { type: "doc", id: "api/collections", label: "Collections" },
        { type: "doc", id: "api/setup", label: "Setup and health" },
        { type: "doc", id: "sdk/index", label: "Client SDK" },
      ],
    },
  ],
};

export default sidebars;
