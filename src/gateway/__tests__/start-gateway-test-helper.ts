import {
  startGatewayIfEnabled,
  type StartGatewayOpts,
} from "../start-gateway";
import { isGatewayEnabled } from "../gateway-bootstrap";
import { planSurfaceOwnership } from "../surface-ownership-plan";

export function startGatewayWithPlan(
  opts: Omit<StartGatewayOpts, "ownershipPlan">,
): ReturnType<typeof startGatewayIfEnabled> {
  return startGatewayIfEnabled({
    ...opts,
    ownershipPlan: planSurfaceOwnership({
      surfaces: opts.surfaces,
      gatewayEnabled: isGatewayEnabled(opts.env),
      principal: opts.principal,
    }),
  });
}
