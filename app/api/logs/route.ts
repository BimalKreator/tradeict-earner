import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import path from "path";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userEmail = session.user.email;
    const logPath = path.join(process.cwd(), "trade-logs.json");
    if (!fs.existsSync(logPath)) return NextResponse.json([]);
    const data = fs.readFileSync(logPath, "utf-8");
    const raw = JSON.parse(data);
    const logs = Array.isArray(raw) ? raw : [];
    const filtered = logs.filter(
      (log: { userEmail?: string }) =>
        typeof log.userEmail === "string" && log.userEmail === userEmail
    );
    return NextResponse.json(filtered);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
