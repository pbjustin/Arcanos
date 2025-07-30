// Example connection using Prisma Client
// This demonstrates how to use Prisma with the User model

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    // Example: Create a new user
    const newUser = await prisma.user.create({
      data: {
        email: 'user@example.com',
        name: 'John Doe',
      },
    });
    console.log('Created user:', newUser);

    // Example: Find all users
    const users = await prisma.user.findMany();
    console.log('All users:', users);

    // Example: Find user by email
    const user = await prisma.user.findUnique({
      where: { email: 'user@example.com' },
    });
    console.log('Found user:', user);

    // Example: Update user
    const updatedUser = await prisma.user.update({
      where: { email: 'user@example.com' },
      data: { name: 'Jane Doe' },
    });
    console.log('Updated user:', updatedUser);

  } catch (error) {
    console.error('Database error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Export the main function for use in other modules
export { main, prisma };

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}