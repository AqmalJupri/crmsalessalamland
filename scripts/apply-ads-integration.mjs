#!/usr/bin/env node
import fs from "node:fs/promises";

const DEFAULT_BASE_URL = "https://salamland.my";

function required(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${payload.error || text || response.statusText}`);
  }
  return payload;
}

function mergeConnection(current, incoming) {
  return {
    ...current,
    ...incoming,
    companyId: current.companyId,
    metaPageId: String(incoming.metaPageId || current.metaPageId || "").trim(),
    metaFormIds: String(incoming.metaFormIds || current.metaFormIds || "").trim(),
    tiktokAdvertiserId: String(incoming.tiktokAdvertiserId || current.tiktokAdvertiserId || "").trim(),
    tiktokFormIds: String(incoming.tiktokFormIds || current.tiktokFormIds || "").trim()
  };
}

function validateConnection(connection) {
  if (connection.metaEnabled && !connection.metaPageId && !connection.metaFormIds) {
    throw new Error(`${connection.companyId}: metaEnabled needs metaPageId or metaFormIds`);
  }
  if (connection.tiktokEnabled && !connection.tiktokAdvertiserId && !connection.tiktokFormIds) {
    throw new Error(`${connection.companyId}: tiktokEnabled needs tiktokAdvertiserId or tiktokFormIds`);
  }
}

async function main() {
  const configPath = process.argv[2] || "ads-integration-config.private.json";
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const username = required(config.username || process.env.CRM_USERNAME, "CRM username");
  const password = required(config.password || process.env.CRM_PASSWORD, "CRM password");

  const login = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username, password })
  });

  const existing = await fetchJson(`${baseUrl}/api/integrations`, { token: login.token });
  const incomingMap = new Map((config.connections || []).map((item) => [item.companyId, item]));
  const connections = (existing.connections || []).map((connection) => mergeConnection(connection, incomingMap.get(connection.companyId) || {}));
  connections.forEach(validateConnection);

  const payload = {
    ...existing,
    publicBaseUrl: baseUrl,
    meta: {
      ...existing.meta,
      ...(config.meta || {})
    },
    tiktok: {
      ...existing.tiktok,
      ...(config.tiktok || {})
    },
    connections
  };

  const saved = await fetchJson(`${baseUrl}/api/integrations`, {
    method: "PUT",
    token: login.token,
    body: JSON.stringify(payload)
  });

  console.log(JSON.stringify({
    ok: true,
    publicBaseUrl: saved.publicBaseUrl,
    connections: saved.connections.map((connection) => ({
      companyId: connection.companyId,
      metaEnabled: connection.metaEnabled,
      metaPageId: connection.metaPageId,
      metaFormIds: connection.metaFormIds,
      tiktokEnabled: connection.tiktokEnabled,
      tiktokAdvertiserId: connection.tiktokAdvertiserId,
      tiktokFormIds: connection.tiktokFormIds
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
