#!/usr/bin/env node

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v22.0";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.argv[2] || "";
const REGISTER_PIN = process.env.WHATSAPP_REGISTER_PIN || process.argv[3] || "";

function fail(message) {
  console.error(`Register failed: ${message}`);
  process.exit(1);
}

if (!ACCESS_TOKEN) fail("Missing WHATSAPP_ACCESS_TOKEN env.");
if (!PHONE_NUMBER_ID) fail("Missing WHATSAPP_PHONE_NUMBER_ID env or first CLI argument.");
if (REGISTER_PIN && !/^\d{6}$/.test(String(REGISTER_PIN))) {
  fail("PIN must be 6 digits when provided. Leave WHATSAPP_REGISTER_PIN empty to register without a PIN.");
}

async function main() {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      ...(REGISTER_PIN ? { pin: String(REGISTER_PIN) } : {})
    })
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text().catch(() => "") };
  }

  if (!response.ok) {
    fail(body?.error?.message || `HTTP ${response.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    success: Boolean(body?.success ?? true),
    phone_number_id: PHONE_NUMBER_ID,
    graph_api_version: GRAPH_API_VERSION
  }, null, 2));
}

main().catch((error) => fail(error.message || "Unknown error"));
