import NextAuth, { type NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

/**
 * NextAuth options for MatatuLink.
 *
 * The auth principal is an `Owner` row. Each Owner belongs to exactly
 * one SACCO, so logging in implicitly scopes every subsequent API
 * request to that SACCO's buses / routes / passengers.
 *
 * The session JWT carries `ownerId`, `saccoId`, `saccoName`, and
 * `region` — sacco-context.ts reads these via getServerSession so all
 * existing `/api/*` routes get tenant isolation for free.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "SACCO Owner",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "owner@sacco.co.ke" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        // Using findFirst because Prisma's SQLite runtime doesn't always
        // expose `email` as a valid `findUnique` lookup key (Turbopack
        // caching quirk even though the schema marks it @unique). Since
        // email is `@unique` at the DB level, findFirst by email still
        // returns at most one row.
        const owner = await db.owner.findFirst({
          where: { email: credentials.email.toLowerCase() },
          include: { sacco: true },
        });
        if (!owner || !owner.passwordHash) return null;
        const ok = await bcrypt.compare(credentials.password, owner.passwordHash);
        if (!ok) return null;
        return {
          id: owner.id,
          name: owner.name,
          email: owner.email ?? undefined,
          // custom fields propagated into the JWT below
          saccoId: owner.saccoId,
          saccoName: owner.sacco.name,
          region: owner.sacco.region,
        } as any;
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    // We render our own sign-in form inside the main page, so point
    // NextAuth's default flow at / (handled client-side).
    signIn: "/",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as any;
        token.ownerId = u.id;
        token.saccoId = u.saccoId;
        token.saccoName = u.saccoName;
        token.region = u.region;
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).ownerId = token.ownerId;
      (session as any).saccoId = token.saccoId;
      (session as any).saccoName = token.saccoName;
      (session as any).region = token.region;
      if (session.user) {
        (session.user as any).id = token.ownerId;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
