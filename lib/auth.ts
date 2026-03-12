import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { findUserByEmail, verifyPassword } from "./auth-users";

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET || "fallback_secret_that_is_at_least_32_characters_long_for_safety",
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
};
