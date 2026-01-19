# Prisma Integration Guide

This project now includes Prisma ORM for type-safe database operations with PostgreSQL.

## Setup Instructions

### 1. Install Dependencies
The following packages have been added:
```bash
npm install prisma @prisma/client
```

### 2. Environment Configuration
Set your Railway PostgreSQL URL in `.env`:
```env
DATABASE_URL="postgresql://<user>:<password>@<host>:<port>/<db>?schema=public"
```

### 3. Database Schema
The Prisma schema is defined in `prisma/schema.prisma` with the following User model:
```prisma
model User {
  id        Int     @id @default(autoincrement())
  email     String  @unique
  name      String?
  createdAt DateTime @default(now())
}
```

Prisma migrations are the source of truth for domain tables. Add or change core
entities in the Prisma schema first, then run the migration workflow to apply
those updates in each environment to avoid drift.

### 4. Prisma Commands
Available npm scripts for Prisma:
```bash
npm run prisma:generate  # Generate Prisma client
npm run prisma:push      # Push schema to database
npm run prisma:studio    # Open Prisma Studio
```

### 5. Usage in Application
Example connection code (see `src/index.ts`):
```javascript
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany();
  console.log(users);
}
main();
```

## Database Operations

### Create User
```javascript
const user = await prisma.user.create({
  data: {
    email: 'user@example.com',
    name: 'John Doe',
  },
});
```

### Find Users
```javascript
const users = await prisma.user.findMany();
const user = await prisma.user.findUnique({
  where: { email: 'user@example.com' }
});
```

### Update User
```javascript
const updatedUser = await prisma.user.update({
  where: { email: 'user@example.com' },
  data: { name: 'Jane Doe' },
});
```

### Delete User
```javascript
await prisma.user.delete({
  where: { email: 'user@example.com' }
});
```

## Railway Integration

1. Set up your Railway PostgreSQL database
2. Copy the connection string to your `.env` file as `DATABASE_URL`
3. Run `npm run prisma:push` to sync your schema
4. Your application will now use Prisma for database operations

## Files Added/Modified

- `prisma/schema.prisma` - Database schema definition
- `src/index.ts` - Added Prisma client example
- `package.json` - Added Prisma dependencies and scripts
- `prisma-example.js` - Comprehensive usage examples
- `.env` - Database configuration (copied from .env.example)
