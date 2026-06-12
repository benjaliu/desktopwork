// src/platform/app-registry.ts
import type { Express } from 'express';

export interface AppRegistration {
  id: string;
  name: string;
  version: string;
  mountRoutes(app: Express): void;
  mountStatic?(app: Express): void;
}

const apps = new Map<string, AppRegistration>();

export function registerApp(app: AppRegistration): void {
  apps.set(app.id, app);
}

export function getApp(id: string): AppRegistration | undefined {
  return apps.get(id);
}

export function listApps(): AppRegistration[] {
  return Array.from(apps.values());
}

export function mountAllRoutes(app: Express): void {
  for (const reg of apps.values()) {
    reg.mountRoutes(app);
  }
}

export function mountAllStatic(app: Express): void {
  for (const reg of apps.values()) {
    reg.mountStatic?.(app);
  }
}