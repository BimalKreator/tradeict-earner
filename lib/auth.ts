import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { findUserByEmail, verifyPassword } from "./auth-users";

const FALLBACK_SECRET =
  "tradeict-earner-fallback-secret-min-32-chars-long-for-jwt-signing";
function getSecret(): string {
  const env = process.env.NEXTAUTH_SECRET;
  if (typeof env === "string" && env.trim().length >= 32) return env.trim();
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return FALLBACK_SECRET;
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) {
            console.error("[NextAuth authorize] Missing email or password");
            return null;
          }
          const user = findUserByEmail(credentials.email);
          if (!user) {
            console.error("[NextAuth authorize] User not found:", credentials.email);
            return null;
          }
          if (!verifyPassword(user, credentials.password)) {
            console.error("[NextAuth authorize] Invalid password for:", credentials.email);
            return null;
          }
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            image: null,
          };
        } catch (err) {
          console.error("[NextAuth authorize] Exception:", err);
          throw err;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.email = token.email as string;
        session.user.name = token.name as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  secret: getSecret(),
};
