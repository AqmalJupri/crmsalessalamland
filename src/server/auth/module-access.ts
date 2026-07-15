export const CRM_MODULE_ACCESS = {
  finance: { capability: "finance.read", returnTo: "/finance" },
  inventory: { capability: "inventory.read", returnTo: "/inventory" },
  leads: { capability: "lead.read", returnTo: "/leads" },
  marketing: { capability: "marketing.read", returnTo: "/marketing" },
  orders: { capability: "order.read", returnTo: "/orders" },
  pipeline: { capability: "opportunity.read", returnTo: "/pipeline" },
  reports: { capability: "report.read", returnTo: "/reports" },
  settings: { capability: "settings.read", returnTo: "/settings" },
  tasks: { capability: "task.read", returnTo: "/tasks" },
  team: { capability: "team.read", returnTo: "/team" },
} as const;

export type CrmModuleKey = keyof typeof CRM_MODULE_ACCESS;

export const CRM_MODULE_READ_CAPABILITIES = Object.values(CRM_MODULE_ACCESS).map(
  ({ capability }) => capability,
);
