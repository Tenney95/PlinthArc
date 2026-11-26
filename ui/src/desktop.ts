import { invoke, isTauri } from '@tauri-apps/api/core';

export function isDesktop(): boolean {
  return isTauri();
}

export async function chooseDirectory(): Promise<string | null> {
  return isDesktop() ? invoke<string | null>('choose_directory') : null;
}
