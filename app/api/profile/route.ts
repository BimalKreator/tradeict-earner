import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { findUserByEmail, updateUser } from "@/lib/auth-users";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = findUserByEmail(session.user.email);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  return NextResponse.json({
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    apiKeys: user.apiKeys ?? {
      binanceApiKey: "",
      binanceApiSecret: "",
      bybitApiKey: "",
      bybitApiSecret: "",
    },
  });
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { name, email, mobile, password, apiKeys } = body;
    const updated = updateUser(session.user.email, {
      ...(name !== undefined && { name: String(name) }),
      ...(email !== undefined && { email: String(email) }),
      ...(mobile !== undefined && { mobile: String(mobile) }),
      ...(password !== undefined && password !== "" && { password: String(password) }),
      ...(apiKeys !== undefined &&
        typeof apiKeys === "object" && {
          apiKeys: {
            binanceApiKey: typeof apiKeys.binanceApiKey === "string" ? apiKeys.binanceApiKey : "",
            binanceApiSecret: typeof apiKeys.binanceApiSecret === "string" ? apiKeys.binanceApiSecret : "",
            bybitApiKey: typeof apiKeys.bybitApiKey === "string" ? apiKeys.bybitApiKey : "",
            bybitApiSecret: typeof apiKeys.bybitApiSecret === "string" ? apiKeys.bybitApiSecret : "",
          },
        }),
    });
    if (!updated) {
      return NextResponse.json({ error: "Update failed" }, { status: 400 });
    }
    return NextResponse.json({
      name: updated.name,
      email: updated.email,
      mobile: updated.mobile,
      apiKeys: updated.apiKeys ?? {
        binanceApiKey: "",
        binanceApiSecret: "",
        bybitApiKey: "",
        bybitApiSecret: "",
      },
    });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
