import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { findUserByEmail, updateUser } from "@/lib/auth-users";

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
  });
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { name, email, mobile, password } = body;
    const updated = updateUser(session.user.email, {
      ...(name !== undefined && { name: String(name) }),
      ...(email !== undefined && { email: String(email) }),
      ...(mobile !== undefined && { mobile: String(mobile) }),
      ...(password !== undefined && password !== "" && { password: String(password) }),
    });
    if (!updated) {
      return NextResponse.json({ error: "Update failed" }, { status: 400 });
    }
    return NextResponse.json({
      name: updated.name,
      email: updated.email,
      mobile: updated.mobile,
    });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
