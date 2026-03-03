class PrismaClientMock {
  $connect = async () => undefined;
  $disconnect = async () => undefined;
  $use = () => undefined;
}

export const PrismaClient = PrismaClientMock;
export const Prisma = {};
export default { PrismaClient };
