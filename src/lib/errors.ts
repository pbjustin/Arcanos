export enum HttpCode {
  OK = 200,
  CREATED = 201,
  NO_CONTENT = 204,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  METHOD_NOT_ALLOWED = 405,
  CONFLICT = 409,
  INTERNAL_SERVER_ERROR = 500,
}

interface AppErrorArgs {
  name?: string;
  httpCode: HttpCode;
  description: string;
  isOperational?: boolean;
}

export class AppError extends Error {
  public readonly name: string;
  public readonly httpCode: HttpCode;
  public readonly isOperational: boolean = true;

  constructor(args: AppErrorArgs) {
    super(args.description);

    Object.setPrototypeOf(this, new.target.prototype);

    this.name = args.name || this.constructor.name;
    this.httpCode = args.httpCode;

    if (args.isOperational !== undefined) {
      this.isOperational = args.isOperational;
    }

    Error.captureStackTrace(this);
  }
}

export class ApiError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.INTERNAL_SERVER_ERROR,
    description = 'Internal Server Error',
    isOperational = true,
  ) {
    super({ name, httpCode, description, isOperational });
  }
}

export class DatabaseError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.INTERNAL_SERVER_ERROR,
    description = 'Database Error',
    isOperational = false, // Usually not operational
  ) {
    super({ name, httpCode, description, isOperational });
  }
}

export class ValidationError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.BAD_REQUEST,
    description = 'Validation Error',
  ) {
    super({ name, httpCode, description, isOperational: true });
  }
}

export class NotFoundError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.NOT_FOUND,
    description = 'Not Found',
  ) {
    super({ name, httpCode, description, isOperational: true });
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.UNAUTHORIZED,
    description = 'Unauthorized',
  ) {
    super({ name, httpCode, description, isOperational: true });
  }
}

export class ForbiddenError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.FORBIDDEN,
    description = 'Forbidden',
  ) {
    super({ name, httpCode, description, isOperational: true });
  }
}

export class BadRequestError extends AppError {
    constructor(
      name: string,
      httpCode = HttpCode.BAD_REQUEST,
      description = 'Bad Request',
    ) {
      super({ name, httpCode, description, isOperational: true });
    }
  }

export class FileStorageError extends AppError {
  constructor(
    name: string,
    httpCode = HttpCode.INTERNAL_SERVER_ERROR,
    description = 'File Storage Error',
    isOperational = false,
  ) {
    super({ name, httpCode, description, isOperational });
  }
}