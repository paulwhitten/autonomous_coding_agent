// Express ESM compatibility shim
//
// @types/express uses `export = e` (CommonJS namespace) which prevents
// named imports (`import { Router } from 'express'`) when "module" is "ESNext".
// This shim re-exports the types and values route files need.

import express from 'express';
export type { Request, Response, NextFunction } from 'express-serve-static-core';

export const Router = express.Router;
export type Router = ReturnType<typeof express.Router>;
