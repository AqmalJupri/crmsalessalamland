const runtimeSmokeInstancePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const RUNTIME_SMOKE_INSTANCE_HEADER = "X-Runtime-Smoke-Instance";

export function getRuntimeSmokeInstanceHeaders(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const instanceId = environment.RUNTIME_SMOKE_INSTANCE_ID;
  if (!instanceId || !runtimeSmokeInstancePattern.test(instanceId)) return {};
  return { [RUNTIME_SMOKE_INSTANCE_HEADER]: instanceId };
}
