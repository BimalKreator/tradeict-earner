import { withAuth } from "next-auth/middleware";

const protectedPaths = ["/", "/dashboard", "/screener", "/settings", "/funds", "/logs", "/profile"];

export default withAuth({
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized: ({ token, req }) => {
      const pathname = req.nextUrl.pathname;
      if (pathname === "/login") return true;
      if (protectedPaths.some((p) => p === pathname || pathname.startsWith(p + "/"))) {
        return !!token;
      }
      return true;
    },
  },
});

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/screener/:path*",
    "/settings/:path*",
    "/funds/:path*",
    "/logs/:path*",
    "/profile/:path*",
    "/login",
  ],
};
