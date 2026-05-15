/**
 * user-auth — User, agent, and role auth for the Mission Control worker.
 *
 * Absorbed from the standalone grove-auth repo in cortex#198; see
 * ./README.md for provenance. Public API: middleware + types + authRoutes.
 */

export {
  requireAuth,
  authenticateUser,
  requireRole,
  requireAgentAccess,
  getUserByEmail,
  validateCfAccessJwt,
  getCfAccessEmail,
  logAuditEvent,
  getClientIp,
} from "./middleware";

export type {
  Role,
  AgentClass,
  GrantScope,
  UserRecord,
  AgentRecord,
  GrantRecord,
  AuthBindings,
} from "./types";

export { ROLE_HIERARCHY, SCOPE_HIERARCHY } from "./types";

export { checkRole, checkAgentAccess } from "./authorize";
export type { RoleCheckResult, AgentAccessInput, AgentAccessResult } from "./authorize";

export { authRoutes } from "./routes/auth";
