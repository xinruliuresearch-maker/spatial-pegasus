import { DEMO_USER_ID } from './demo-identity'

/**
 * Resolve the single local Demo owner.
 *
 * There is deliberately no browser account/session layer. The application is
 * bound to loopback and every public request shares this stable internal owner
 * key, preserving project isolation and CAS semantics inside the database.
 * The Response union is retained temporarily so existing API call sites keep
 * their fail-closed control-flow shape even though this resolver never returns
 * a browser-auth error.
 */
export async function resolveLocalOwner(): Promise<string | Response> {
  return DEMO_USER_ID
}
