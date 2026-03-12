import { createHash } from "crypto";
import fs from "fs";
import path from "path";

export interface ApiKeysData {
  binanceApiKey?: string;
  binanceApiSecret?: string;
  bybitApiKey?: string;
  bybitApiSecret?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  mobile: string;
  apiKeys?: ApiKeysData;
}

function hashPassword(password: string): string {
  try {
    return createHash("sha256").update(password, "utf8").digest("hex");
  } catch (err) {
    console.error("[auth-users] hashPassword failed:", err);
    throw err;
  }
}

const USERS_FILE = path.join(process.cwd(), "users.json");

function getDefaultUsersArray(): UserRecord[] {
  const demoHash = hashPassword("demo123");
  return [
    {
      id: "1",
      email: "admin@tradeict.com",
      passwordHash: demoHash,
      name: "Admin User",
      mobile: "",
    },
    {
      id: "2",
      email: "admin@tradeictearner.online",
      passwordHash: demoHash,
      name: "Admin",
      mobile: "",
    },
  ];
}

function loadUsers(): UserRecord[] {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return getDefaultUsersArray();
    return parsed as UserRecord[];
  } catch {
    const defaults = getDefaultUsersArray();
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(defaults, null, 2), "utf8");
    } catch {}
    return defaults;
  }
}

function saveUsers(usersArray: UserRecord[]): void {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersArray, null, 2), "utf8");
  } catch (err) {
    console.error("[auth-users] saveUsers failed:", err);
    throw err;
  }
}

const users = new Map<string, UserRecord>();
let defaultUserInitialized = false;

function ensureDefaultUser(): void {
  if (defaultUserInitialized) return;
  defaultUserInitialized = true;
  try {
    const list = loadUsers();
    for (const u of list) {
      const key = u.email?.trim().toLowerCase();
      if (key) users.set(key, u);
    }
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

/**
 * Update a user by current email. New email updates the record so findUserByEmail works with the new email.
 * New password is hashed before storing. apiKeys are stored as provided (sync across devices).
 */
export function updateUser(
  currentEmail: string,
  updates: {
    name?: string;
    email?: string;
    mobile?: string;
    password?: string;
    apiKeys?: ApiKeysData;
  }
): UserRecord | null {
  ensureDefaultUser();
  const normalized = currentEmail?.trim().toLowerCase();
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
  if (updates.apiKeys !== undefined) {
    user.apiKeys = {
      binanceApiKey: typeof updates.apiKeys.binanceApiKey === "string" ? updates.apiKeys.binanceApiKey : "",
      binanceApiSecret: typeof updates.apiKeys.binanceApiSecret === "string" ? updates.apiKeys.binanceApiSecret : "",
      bybitApiKey: typeof updates.apiKeys.bybitApiKey === "string" ? updates.apiKeys.bybitApiKey : "",
      bybitApiSecret: typeof updates.apiKeys.bybitApiSecret === "string" ? updates.apiKeys.bybitApiSecret : "",
    };
  }
  saveUsers(Array.from(users.values()));
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
  saveUsers(Array.from(users.values()));
  return user;
}
