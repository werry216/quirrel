module.exports = {
  home: [
    "docs/introduction",
    {
      type: "category",
      label: "Getting Started",
      collapsed: false,
      items: ["docs/getting-started/next-js", "docs/getting-started/blitz-js"],
    },
    "docs/deploying",
    "docs/migrating-to-v1",
    "docs/how-quirrel-works",
    "docs/faq",
  ],
  docs: [
    "api/index",
    {
      type: "category",
      label: "API Reference",
      collapsed: false,
      items: ["api/queue", "api/cronjob"],
    },
    {
      type: "category",
      label: "Frameworks",
      collapsed: false,
      items: [
        "api/next",
        "api/blitz",
        "api/redwood",
        "api/nuxt",
        "api/express",
        "api/vercel",
      ],
    },
  ],
};
