import { LogIn } from "lucide-react";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const href = `/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <div className="crm-login-form">
      <a className="crm-button crm-button--primary crm-button--lg" href={href}>
        <LogIn aria-hidden="true" />
        Log masuk
      </a>
    </div>
  );
}
