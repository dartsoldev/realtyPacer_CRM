import { Wrench } from "lucide-react";
import { isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Shown when required server configuration is missing. Lists variable names
 * (never values) outside production; in production details go to the logs.
 */
export function SetupRequired({ issues, service = "server" }: { issues: string[]; service?: string }) {
  const showDetails = !isProduction();
  if (!showDetails) logger.error("config.setup_required", { service, issues });
  return (
    <div role="alert" className="rounded-xl border border-pending/30 bg-pending-soft p-5 text-sm">
      <div className="flex items-center gap-2 font-semibold text-pending">
        <Wrench className="size-4" aria-hidden />
        Setup required
      </div>
      <p className="mt-2 text-ink">
        RealtyPacer can’t reach its {service} configuration yet, so nothing can be signed in to or saved. An administrator needs to finish
        configuring the environment.
      </p>
      {showDetails ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 font-mono text-xs text-ink">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-muted">Details have been written to the server log.</p>
      )}
      {showDetails ? <p className="mt-3 text-muted">See README.md → “Environment variables”.</p> : null}
    </div>
  );
}
