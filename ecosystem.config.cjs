module.exports = {
  apps: [
    {
      name: "crm-salamland-my",
      script: "./server.js",
      cwd: "/var/www/crm.salamland.my",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
        HOST: process.env.HOST || "127.0.0.1",
        PORT: process.env.PORT || "8877",
        CRM_REQUIRE_WEBHOOK_SIGNATURES: process.env.CRM_REQUIRE_WEBHOOK_SIGNATURES || "true",
        META_APP_SECRET: process.env.META_APP_SECRET || "",
        META_ALLOW_UNSIGNED_WEBHOOKS: process.env.META_ALLOW_UNSIGNED_WEBHOOKS || "false",
        TIKTOK_ALLOW_UNSIGNED_WEBHOOKS: process.env.TIKTOK_ALLOW_UNSIGNED_WEBHOOKS || "false",
        GOLD_RATE_CACHE_MS: process.env.GOLD_RATE_CACHE_MS || "1800000",
        WHATSAPP_GRAPH_API_VERSION: process.env.WHATSAPP_GRAPH_API_VERSION || "v22.0",
        WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || "",
        WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
        WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "",
        WHATSAPP_DEFAULT_TEMPLATE_NAME: process.env.WHATSAPP_DEFAULT_TEMPLATE_NAME || "",
        WHATSAPP_DEFAULT_LANGUAGE_CODE: process.env.WHATSAPP_DEFAULT_LANGUAGE_CODE || "ms"
      }
    }
  ]
};
