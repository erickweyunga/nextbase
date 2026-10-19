import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "index",
    "getting-started",
    {
      type: "category",
      label: "Guides",
      collapsed: false,
      items: [
        "guides/collections",
        "guides/records",
        "guides/filters",
        "guides/rules",
        {
          type: "category",
          label: "Authentication",
          link: { type: "doc", id: "guides/auth/index" },
          items: ["guides/auth/sessions"],
        },
        "guides/server",
        "guides/production",
      ],
    },
    {
      type: "category",
      label: "REST API reference",
      link: { type: "doc", id: "api/index" },
      items: ["api/records", "api/auth", "api/collections", "api/setup"],
    },
    "sdk/index",
  ],
};

export default sidebars;
