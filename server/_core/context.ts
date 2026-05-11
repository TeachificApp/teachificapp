import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { resolveTeachificSessionUser } from "./teachificSession";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: (User & { impersonatedBy?: string }) | null;
};

/** Resolve a user from the custom Teachific email/password session cookie */
async function resolveTeachificSession(cookieHeader: string | undefined): Promise<User | null> {
  try {
    return await resolveTeachificSessionUser(cookieHeader);
  } catch {
    return null;
  }
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: (User & { impersonatedBy?: string }) | null = null;

  try {
    // Primary: Manus OAuth / app_session_id cookie
    user = await sdk.authenticateRequest(opts.req);
  } catch {
    // Fallback: custom Teachific email/password session cookie
    user = await resolveTeachificSession(opts.req.headers.cookie);
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
