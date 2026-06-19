// Quick diagnostic: list owners with their stored password hashes
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";

async function main() {
  const owners = await db.owner.findMany({ select: { id: true, name: true, email: true, passwordHash: true, sacco: { select: { name: true } } } });
  for (const o of owners) {
    console.log(`\n${o.name} <${o.email}> — ${o.sacco.name}`);
    console.log(`  passwordHash: ${o.passwordHash ? o.passwordHash.slice(0, 30) + '...' : 'NULL'}`);
    if (o.passwordHash) {
      const expected = o.email?.includes('grace') ? 'nairobi123' : 'matatu123';
      const ok = await bcrypt.compare(expected, o.passwordHash);
      console.log(`  bcrypt.compare('${expected}', hash) => ${ok}`);
    }
  }
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
