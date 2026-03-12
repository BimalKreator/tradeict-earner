import { createHash } from "crypto";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  mobile: string;
}

function hashPassword(password: string): string {
  try {
    return createHash("sha256").update(password, "utf8").digest("hex");
  } catch (err) {
    console.error("[auth-users] hashPassword failed:", err);
    throw err;
  }
}

// In-memory user store. In production, replace with a database.
const users = new Map<string, UserRecord>();
let defaultUserInitialized = false;

function ensureDefaultUser(): void {
  if (defaultUserInitialized) return;
  defaultUserInitialized = true;
  try {
    const defaultPasswordHash = hashPassword("demo123");
    users.set("admin@tradeict.com", {
      id: "1",
      email: "admin@tradeict.com",
      passwordHash: defaultPasswordHash,
      name: "Admin User",
      mobile: "",
    });
  } catch (err) {
    console.error("[auth-users] ensureDefaultUser failed:", err);
    throw err;
  }
}

export function findUserByEmail(email: string): UserRecord | null {
  ensureDefaultUser();
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  return users.get(normalized) ?? null;
}

export function verifyPassword(user: UserRecord, password: string): boolean {
  try {
    return user.passwordHash === hashPassword(password);
  } catch (err) {
    console.error("[auth-users] verifyPassword failed:", err);
    return false;
  }
}

export function updateUser(
  email: string,
  updates: { name?: string; email?: string; mobile?: string; password?: string }
): UserRecord | null {
  ensureDefaultUser();
  const normalized = email?.trim().toLowerCase();
  const user = users.get(normalized);
  if (!user) return null;

  if (updates.email !== undefined) {
    const newEmail = updates.email.trim().toLowerCase();
    if (newEmail && newEmail !== normalized) {
      users.delete(normalized);
      user.email = newEmail;
      users.set(newEmail, user);
    }
  }
  if (updates.name !== undefined) user.name = updates.name.trim();
  if (updates.mobile !== undefined) user.mobile = updates.mobile.trim();
  if (updates.password !== undefined && updates.password.length >= 6) {
    user.passwordHash = hashPassword(updates.password);
  }
  return user;
}

export function createUser(
  email: string,
  password: string,
  name: string,
  mobile: string = ""
): UserRecord | null {
  ensureDefaultUser();
  const normalized = email?.trim().toLowerCase();
  if (!normalized || password.length < 6) return null;
  if (users.has(normalized)) return null;
  const user: UserRecord = {
    id: String(users.size + 1),
    email: normalized,
    passwordHash: hashPassword(password),
    name: name.trim() || normalized,
    mobile: mobile.trim(),
  };
  users.set(normalized, user);
  return user;
}
