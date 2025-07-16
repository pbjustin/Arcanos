import type { Request, Response, NextFunction } from 'express';
export declare function securityHeaders(_req: Request, res: Response, next: NextFunction): void;
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
export declare function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void;
export declare function requireAuth(req: Request, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function requireRole(role: string): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=index.d.ts.map